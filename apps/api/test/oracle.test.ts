import { afterEach, describe, expect, it } from 'vitest'
import type { AlertEvent, Alerter } from '../src/alerts/types'
import type { Database } from '../src/db/client'
import { DexScreenerUsdSource } from '../src/oracle/dexscreener'
import { JupiterUsdSource, type FetchFn } from '../src/oracle/jupiter'
import { MockUsdSource } from '../src/oracle/mock'
import {
  createUsdSources,
  DEFAULT_SCRATCHY_PUMP_KEY,
  poolPriceFromVenue,
  PriceOracleImpl,
  pumpUsdKey,
  type PriceOracleOptions,
} from '../src/oracle/oracle'
import { DbPricesStore, MemoryPricesStore, type PricesStore } from '../src/oracle/store'
import type { PriceQuote, UsdPriceSource } from '../src/oracle/types'
import { freshDatabase } from './helpers/db'

/**
 * Dual price oracle (PLAN §3): source parsing, fallback order, fresh → stale → frozen → recovery,
 * single-flight, persistence across restarts, exact SCRATCHY/USD math. No network: fetch is injected.
 */

const PUMP = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn'
const OTHER = 'So11111111111111111111111111111111111111112'
const E18 = 10n ** 18n
const T0 = Date.parse('2026-09-29T12:00:00Z')

// ---------------------------------------------------------------------------------------------- helpers

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Call {
  url: string
  headers: Record<string, string>
}

function fakeFetch(handler: (url: string) => Response | Promise<Response>): FetchFn & { calls: Call[] } {
  const calls: Call[] = []
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } })
    return handler(url)
  }
  return Object.assign(fn, { calls })
}

/** a fetch that only settles when aborted (exercises the AbortController timeout) */
const hangingFetch: FetchFn = (_url, init) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  })

class TestAlerter implements Alerter {
  events: AlertEvent[] = []
  notify(e: AlertEvent) {
    this.events.push(e)
  }
  async flush() {}
  kinds() {
    return this.events.map((e) => e.kind)
  }
}

class FakePool {
  calls = 0
  failing = false
  constructor(public priceE18: bigint) {}
  readonly fn = async (): Promise<bigint> => {
    this.calls++
    if (this.failing) throw new Error('rpc down')
    return this.priceE18
  }
}

interface Harness {
  oracle: PriceOracleImpl
  jup: MockUsdSource
  dex: MockUsdSource
  pool: FakePool
  store: MemoryPricesStore
  alerter: TestAlerter
  advance(seconds: number): void
}

let clock = T0

function harness(over: Partial<PriceOracleOptions> & { store?: PricesStore } = {}): Harness {
  clock = T0
  const jup = new MockUsdSource('0.0056652589', 'jupiter')
  const dex = new MockUsdSource('0.0056', 'dexscreener')
  const pool = new FakePool(E18 / 2n) // 1 SCRATCHY = 0.5 PUMP
  const store = new MemoryPricesStore()
  const alerter = new TestAlerter()
  const oracle = new PriceOracleImpl({
    pumpMint: PUMP,
    sources: [jup, dex],
    poolPrice: pool.fn,
    cacheSeconds: 30,
    store,
    alerter,
    now: () => new Date(clock),
    ...over,
  })
  return {
    oracle,
    jup,
    dex,
    pool,
    store: (over.store as MemoryPricesStore | undefined) ?? store,
    alerter,
    advance: (s) => {
      clock += s * 1000
    },
  }
}

// ---------------------------------------------------------------------------------------------- sources

describe('JupiterUsdSource', () => {
  it('parses usdPrice into USD × 1e18 exactly and sends the api key', async () => {
    const f = fakeFetch(() => json({ [PUMP]: { usdPrice: 0.0056652589, decimals: 6, liquidity: 1e6 } }))
    const src = new JupiterUsdSource('https://api.jup.ag/', 'k3y', f)
    expect(await src.fetchUsdPriceE18(PUMP)).toBe(5_665_258_900_000_000n)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe(`https://api.jup.ag/price/v3?ids=${PUMP}`)
    expect(f.calls[0]!.headers['x-api-key']).toBe('k3y')
  })

  it('handles exponent-notation floats and omits the key header when keyless', async () => {
    const f = fakeFetch(() => json({ [PUMP]: { usdPrice: 5.6652589e-7 } }))
    const src = new JupiterUsdSource('https://api.jup.ag', undefined, f)
    expect(await src.fetchUsdPriceE18(PUMP)).toBe(566_525_890_000n)
    expect(f.calls[0]!.headers['x-api-key']).toBeUndefined()
  })

  it('returns null when the mint is absent or the price is unusable', async () => {
    for (const body of [
      {},
      { [OTHER]: { usdPrice: 150 } },
      { [PUMP]: null },
      { [PUMP]: {} },
      { [PUMP]: { usdPrice: null } },
      { [PUMP]: { usdPrice: 0 } },
      { [PUMP]: { usdPrice: -0.01 } },
      { [PUMP]: { usdPrice: 1e-19 } }, // below 1e-18 resolution → 0
    ]) {
      const src = new JupiterUsdSource(
        'https://api.jup.ag',
        undefined,
        fakeFetch(() => json(body)),
      )
      expect(await src.fetchUsdPriceE18(PUMP)).toBeNull()
    }
  })

  it('throws on non-2xx, malformed bodies and timeouts', async () => {
    await expect(
      new JupiterUsdSource(
        'https://api.jup.ag',
        undefined,
        fakeFetch(() => json({ error: 'rl' }, 429)),
      ).fetchUsdPriceE18(PUMP),
    ).rejects.toThrow(/HTTP 429/)
    await expect(
      new JupiterUsdSource(
        'https://api.jup.ag',
        undefined,
        fakeFetch(() => json({}, 500)),
      ).fetchUsdPriceE18(PUMP),
    ).rejects.toThrow(/HTTP 500/)
    await expect(
      new JupiterUsdSource(
        'https://api.jup.ag',
        undefined,
        fakeFetch(() => new Response('<html>')),
      ).fetchUsdPriceE18(PUMP),
    ).rejects.toThrow()
    await expect(
      new JupiterUsdSource(
        'https://api.jup.ag',
        undefined,
        fakeFetch(() => json([1, 2])),
      ).fetchUsdPriceE18(PUMP),
    ).rejects.toThrow(/unexpected response/)
    await expect(
      new JupiterUsdSource('https://api.jup.ag', undefined, hangingFetch, 20).fetchUsdPriceE18(PUMP),
    ).rejects.toThrow(/timed out after 20ms/)
  })
})

describe('DexScreenerUsdSource', () => {
  const pair = (
    base: string,
    priceUsd: string | null,
    liquidityUsd: number | undefined,
    chainId = 'solana',
  ) => ({
    chainId,
    dexId: 'raydium',
    pairAddress: `pair-${base.slice(0, 4)}-${liquidityUsd}`,
    baseToken: { address: base, symbol: base === PUMP ? 'PUMP' : 'X' },
    quoteToken: { address: base === PUMP ? OTHER : PUMP, symbol: 'Q' },
    priceUsd,
    liquidity: liquidityUsd === undefined ? undefined : { usd: liquidityUsd },
  })

  it('picks the highest-liquidity pair whose base token is the mint', async () => {
    const f = fakeFetch(() =>
      json([
        pair(OTHER, '150.12', 9_000_000), // PUMP is the quote here: priceUsd is not PUMP's price
        pair(PUMP, '0.0050', 1_000),
        pair(PUMP, '0.005665', 50_000),
        pair(PUMP, null, 999_999), // deepest, but no price
        pair(PUMP, '0.0099', 5_000_000, 'ethereum'),
        pair(PUMP, '0.0042', undefined),
      ]),
    )
    const src = new DexScreenerUsdSource('https://api.dexscreener.com/', f)
    expect(await src.fetchUsdPriceE18(PUMP)).toBe(5_665_000_000_000_000n)
    expect(f.calls[0]!.url).toBe(`https://api.dexscreener.com/tokens/v1/solana/${PUMP}`)
  })

  it('parses string prices exactly (truncating below 1e-18)', async () => {
    const src = new DexScreenerUsdSource(
      'https://api.dexscreener.com',
      fakeFetch(() => json([pair(PUMP, '0.000000123456789012345678901', 10)])),
    )
    expect(await src.fetchUsdPriceE18(PUMP)).toBe(123_456_789_012n)
  })

  it('returns null when no pair is usable', async () => {
    for (const body of [
      [],
      [pair(OTHER, '1.0', 100)],
      [pair(PUMP, null, 100)],
      [pair(PUMP, '0', 100), pair(PUMP, 'abc', 100), pair(PUMP, '', 100)],
    ]) {
      const src = new DexScreenerUsdSource(
        'https://api.dexscreener.com',
        fakeFetch(() => json(body)),
      )
      expect(await src.fetchUsdPriceE18(PUMP)).toBeNull()
    }
  })

  it('throws on non-2xx, non-array bodies and timeouts', async () => {
    await expect(
      new DexScreenerUsdSource(
        'https://x',
        fakeFetch(() => json({}, 503)),
      ).fetchUsdPriceE18(PUMP),
    ).rejects.toThrow(/HTTP 503/)
    await expect(
      new DexScreenerUsdSource(
        'https://x',
        fakeFetch(() => json({ pairs: null })),
      ).fetchUsdPriceE18(PUMP),
    ).rejects.toThrow(/array/)
    await expect(
      new DexScreenerUsdSource('https://x', hangingFetch, 20).fetchUsdPriceE18(PUMP),
    ).rejects.toThrow(/timed out/)
  })
})

describe('MockUsdSource + createUsdSources', () => {
  it('serves a fixed price, can go missing or fail', async () => {
    const m = new MockUsdSource('0.0056')
    expect(await m.fetchUsdPriceE18(PUMP)).toBe(5_600_000_000_000_000n)
    m.setPrice(null)
    expect(await m.fetchUsdPriceE18(PUMP)).toBeNull()
    m.setFailing(true)
    await expect(m.fetchUsdPriceE18(PUMP)).rejects.toThrow(/simulated outage/)
    expect(() => new MockUsdSource('0')).toThrow()
    expect(() => new MockUsdSource('nope')).toThrow()
  })

  it('builds the configured source chain', () => {
    const base = {
      JUPITER_API_BASE: 'https://api.jup.ag',
      JUPITER_API_KEY: undefined,
      DEXSCREENER_API_BASE: 'https://api.dexscreener.com',
      MOCK_PUMP_USD: '0.0056',
    }
    expect(createUsdSources({ ...base, PRICE_SOURCE: 'live' }).map((s) => s.name)).toEqual([
      'jupiter',
      'dexscreener',
    ])
    expect(createUsdSources({ ...base, PRICE_SOURCE: 'mock' }).map((s) => s.name)).toEqual(['mock'])
  })
})

// ---------------------------------------------------------------------------------------------- oracle

describe('PriceOracleImpl', () => {
  it('starts as none, then serves fresh prices with exact derived SCRATCHY/USD and persists them', async () => {
    const h = harness()
    expect(h.oracle.peek()).toMatchObject({
      state: 'none',
      pumpUsd: null,
      scratchyPump: null,
      scratchyUsd: null,
    })

    const snap = await h.oracle.get()
    expect(snap.state).toBe('fresh')
    expect(snap.pumpUsd).toEqual({ valueE18: 5_665_258_900_000_000n, source: 'jupiter', at: new Date(T0) })
    expect(snap.scratchyPump).toEqual({ valueE18: E18 / 2n, source: 'pool', at: new Date(T0) })
    // 0.5 PUMP × $0.0056652589 = $0.00283262945 exactly
    expect(snap.scratchyUsd?.valueE18).toBe(2_832_629_450_000_000n)
    expect(snap.lastFreshAt).toEqual(new Date(T0))
    expect(h.store.get(pumpUsdKey(PUMP))?.valueE18).toBe(5_665_258_900_000_000n)
    expect(h.store.get(DEFAULT_SCRATCHY_PUMP_KEY)?.valueE18).toBe(E18 / 2n)
    expect(h.oracle.peek()).toEqual(snap)
    expect(h.alerter.events).toEqual([])
  })

  it('caches for cacheSeconds, then refreshes', async () => {
    const h = harness()
    await h.oracle.get()
    h.advance(29)
    await h.oracle.get()
    expect([h.jup.calls, h.pool.calls]).toEqual([1, 1])
    h.advance(1)
    h.pool.priceE18 = E18 // pool moved
    const snap = await h.oracle.get()
    expect([h.jup.calls, h.pool.calls]).toEqual([2, 2])
    expect(snap.scratchyPump?.valueE18).toBe(E18)
    expect(snap.scratchyUsd?.valueE18).toBe(5_665_258_900_000_000n)
    expect(snap.state).toBe('fresh')
  })

  it('falls back in order: Jupiter failing or priceless → DexScreener, and records the source', async () => {
    const h = harness()
    h.jup.setFailing(true)
    let snap = await h.oracle.get()
    expect(snap.state).toBe('fresh')
    expect(snap.pumpUsd).toMatchObject({ valueE18: 5_600_000_000_000_000n, source: 'dexscreener' })
    expect([h.jup.calls, h.dex.calls]).toEqual([1, 1])

    h.jup.setFailing(false)
    h.jup.setPrice(null) // Jupiter answers but has no reliable price
    h.advance(30)
    snap = await h.oracle.get()
    expect(snap.pumpUsd?.source).toBe('dexscreener')

    h.jup.setPrice('0.006')
    h.advance(30)
    snap = await h.oracle.get()
    expect(snap.pumpUsd).toMatchObject({ valueE18: 6_000_000_000_000_000n, source: 'jupiter' })
    expect(h.dex.calls).toBe(2) // not asked once Jupiter answered
  })

  it('falls back through the real HTTP sources (Jupiter 500 → DexScreener)', async () => {
    const f = fakeFetch((url) =>
      url.includes('/price/v3')
        ? json({ error: 'boom' }, 500)
        : json([
            { chainId: 'solana', baseToken: { address: PUMP }, priceUsd: '0.005665', liquidity: { usd: 1 } },
          ]),
    )
    const h = harness({
      sources: [
        new JupiterUsdSource('https://api.jup.ag', undefined, f),
        new DexScreenerUsdSource('https://api.dexscreener.com', f),
      ],
    })
    const snap = await h.oracle.get()
    expect(snap.pumpUsd).toMatchObject({ valueE18: 5_665_000_000_000_000n, source: 'dexscreener' })
    expect(f.calls.map((c) => new URL(c.url).hostname)).toEqual(['api.jup.ag', 'api.dexscreener.com'])
  })

  it('all sources failing → stale, then frozen after 5 × cacheSeconds, keeping the last known values', async () => {
    const h = harness()
    const fresh = await h.oracle.get()
    h.jup.setFailing(true)
    h.dex.setFailing(true)
    h.pool.failing = true

    for (const t of [30, 60, 90, 120]) {
      clock = T0 + t * 1000
      const snap = await h.oracle.get()
      expect(snap.state, `t=${t}s`).toBe('stale')
      expect(snap.pumpUsd).toEqual(fresh.pumpUsd)
      expect(snap.scratchyPump).toEqual(fresh.scratchyPump)
      expect(snap.scratchyUsd).toEqual(fresh.scratchyUsd)
      expect(snap.lastFreshAt).toEqual(new Date(T0))
    }
    expect(h.alerter.events).toEqual([])

    clock = T0 + 150_000
    const frozen = await h.oracle.get()
    expect(frozen.state).toBe('frozen')
    expect(frozen.pumpUsd).toEqual(fresh.pumpUsd)
    expect(frozen.scratchyUsd).toEqual(fresh.scratchyUsd)
    expect(h.alerter.events).toHaveLength(1)
    expect(h.alerter.events[0]).toMatchObject({
      kind: 'oracle_frozen',
      severity: 'critical',
      immediate: true,
      dedupeKey: 'oracle_frozen',
    })
    expect(h.alerter.events[0]!.data?.errors).toEqual([
      'jupiter: jupiter: simulated outage',
      'dexscreener: dexscreener: simulated outage',
      'pool: rpc down',
    ])

    h.advance(300)
    expect((await h.oracle.get()).state).toBe('frozen')
    expect(h.alerter.events).toHaveLength(1) // alerted on entry only
  })

  it('recovers to fresh with new values and alerts the recovery', async () => {
    const h = harness()
    await h.oracle.get()
    h.jup.setFailing(true)
    h.dex.setFailing(true)
    clock = T0 + 150_000
    expect((await h.oracle.get()).state).toBe('frozen')

    h.jup.setFailing(false)
    h.jup.setPrice('0.007')
    h.advance(30)
    const snap = await h.oracle.get()
    expect(snap.state).toBe('fresh')
    expect(snap.pumpUsd).toEqual({ valueE18: 7_000_000_000_000_000n, source: 'jupiter', at: new Date(clock) })
    expect(snap.scratchyUsd?.valueE18).toBe(3_500_000_000_000_000n)
    expect(snap.lastFreshAt).toEqual(new Date(clock))
    expect(h.alerter.kinds()).toEqual(['oracle_frozen', 'oracle_recovered'])
    expect(h.alerter.events[1]).toMatchObject({ severity: 'info', dedupeKey: 'oracle_recovered' })
  })

  it('a failing pool alone makes the snapshot stale, then frozen, even while PUMP/USD is live', async () => {
    const h = harness()
    await h.oracle.get()
    h.pool.failing = true
    h.jup.setPrice('0.006')
    h.advance(30)
    let snap = await h.oracle.get()
    expect(snap.state).toBe('stale')
    expect(snap.pumpUsd).toMatchObject({ valueE18: 6_000_000_000_000_000n, at: new Date(clock) })
    expect(snap.scratchyPump?.at).toEqual(new Date(T0))
    expect(snap.scratchyUsd?.at).toEqual(new Date(T0)) // derived quote is as old as its oldest input
    expect(snap.scratchyUsd?.valueE18).toBe(3_000_000_000_000_000n)
    clock = T0 + 150_000
    snap = await h.oracle.get()
    expect(snap.state).toBe('frozen')
  })

  it('degrades by age in peek() when nobody refreshes', async () => {
    const h = harness()
    await h.oracle.get()
    h.advance(59)
    expect(h.oracle.peek().state).toBe('fresh')
    h.advance(1)
    expect(h.oracle.peek().state).toBe('stale')
    h.advance(90)
    expect(h.oracle.peek().state).toBe('frozen')
    expect(h.jup.calls).toBe(1) // peek never does I/O
  })

  it('is single-flight: concurrent get() calls share one refresh', async () => {
    const h = harness()
    let release!: (v: bigint) => void
    let poolCalls = 0
    const oracle = new PriceOracleImpl({
      pumpMint: PUMP,
      sources: [h.jup, h.dex],
      poolPrice: () => {
        poolCalls++
        return new Promise<bigint>((res) => (release = res))
      },
      cacheSeconds: 30,
      store: h.store,
      now: () => new Date(clock),
    })
    const a = oracle.get()
    const b = oracle.get()
    await new Promise((r) => setTimeout(r, 5))
    const c = oracle.get() // arrives while the refresh is in flight
    await new Promise((r) => setTimeout(r, 5))
    release(E18)
    const [sa, sb, sc] = await Promise.all([a, b, c])
    expect(poolCalls).toBe(1)
    expect(h.jup.calls).toBe(1)
    expect(sa.state).toBe('fresh')
    expect(sb).toEqual(sa)
    expect(sc).toEqual(sa)
  })

  it('reloads persisted prices after a restart: frozen (not none) during an outage', async () => {
    const store = new MemoryPricesStore()
    const first = harness({ store })
    await first.oracle.get()
    const before = first.oracle.peek()

    // restart ten minutes later with every source down
    clock = T0 + 600_000
    const alerter = new TestAlerter()
    const dead = new MockUsdSource('1', 'jupiter')
    dead.setFailing(true)
    const restarted = new PriceOracleImpl({
      pumpMint: PUMP,
      sources: [dead],
      poolPrice: async () => {
        throw new Error('rpc down')
      },
      cacheSeconds: 30,
      store,
      alerter,
      now: () => new Date(clock),
    })
    await restarted.init()
    expect(restarted.peek()).toMatchObject({
      state: 'frozen',
      pumpUsd: before.pumpUsd,
      scratchyUsd: before.scratchyUsd,
    })

    const snap = await restarted.get()
    expect(snap.state).toBe('frozen')
    expect(snap.pumpUsd).toEqual(before.pumpUsd)
    expect(snap.scratchyPump).toEqual(before.scratchyPump)
    expect(snap.scratchyUsd?.valueE18).toBe(2_832_629_450_000_000n)
    expect(snap.lastFreshAt).toEqual(new Date(T0))
    expect(alerter.kinds()).toEqual(['oracle_frozen'])
  })

  it('a quick restart with recent persisted prices starts stale, and a future timestamp is not trusted', async () => {
    clock = T0
    const quote = (v: bigint, at: number): PriceQuote => ({
      valueE18: v,
      source: 'jupiter',
      at: new Date(at),
    })
    const store = new MemoryPricesStore([
      [pumpUsdKey(PUMP), quote(E18, T0 - 60_000)],
      [DEFAULT_SCRATCHY_PUMP_KEY, quote(E18 / 4n, T0 + 3_600_000)], // skewed clock on the old host
    ])
    const dead = new MockUsdSource('1')
    dead.setFailing(true)
    const oracle = new PriceOracleImpl({
      pumpMint: PUMP,
      sources: [dead],
      poolPrice: async () => {
        throw new Error('down')
      },
      cacheSeconds: 30,
      store,
      now: () => new Date(clock),
    })
    const snap = await oracle.get()
    expect(snap.state).toBe('stale')
    expect(snap.scratchyPump?.at).toEqual(new Date(T0)) // clamped to "now"
    expect(snap.scratchyUsd?.valueE18).toBe(E18 / 4n)
    clock = T0 + 90_000 // PUMP/USD value is now 150 s old
    expect((await oracle.get()).state).toBe('frozen')
  })

  it('persisted prices for a different mint are ignored', async () => {
    const store = new MemoryPricesStore([
      [pumpUsdKey(OTHER), { valueE18: E18, source: 'jupiter', at: new Date(T0) }],
      [DEFAULT_SCRATCHY_PUMP_KEY, { valueE18: E18, source: 'pool', at: new Date(T0) }],
    ])
    const h = harness({ store })
    h.jup.setFailing(true)
    h.dex.setFailing(true)
    const snap = await h.oracle.get()
    expect(snap.state).toBe('none')
    expect(snap.pumpUsd).toBeNull()
    expect(snap.scratchyUsd).toBeNull()
  })

  it('never throws: cold start with everything failing is none + alerted, then recovers', async () => {
    const alerter = new TestAlerter()
    const throwsSync: UsdPriceSource = {
      name: 'broken',
      fetchUsdPriceE18: () => {
        throw new Error('sync throw')
      },
    }
    const brokenStore: PricesStore = {
      load: async () => {
        throw new Error('db down')
      },
      save: async () => {
        throw new Error('db down')
      },
    }
    let poolUp = false
    const good = new MockUsdSource('0.01')
    good.setFailing(true)
    clock = T0
    const oracle = new PriceOracleImpl({
      pumpMint: PUMP,
      sources: [throwsSync, good],
      poolPrice: async () => {
        if (!poolUp) throw new Error('rpc down')
        return E18 * 2n
      },
      cacheSeconds: 30,
      store: brokenStore,
      alerter,
      now: () => new Date(clock),
    })
    const snap = await oracle.get()
    expect(snap).toMatchObject({
      state: 'none',
      pumpUsd: null,
      scratchyPump: null,
      scratchyUsd: null,
      lastFreshAt: null,
    })
    expect(alerter.kinds()).toEqual(['oracle_unavailable'])

    good.setFailing(false)
    poolUp = true
    clock += 30_000
    const ok = await oracle.get()
    expect(ok.state).toBe('fresh')
    expect(ok.pumpUsd?.source).toBe('mock')
    expect(ok.scratchyUsd?.valueE18).toBe(2n * 10n ** 16n) // 2 PUMP × $0.01
    expect(alerter.kinds()).toEqual(['oracle_unavailable', 'oracle_recovered'])

    const throwingAlerter: Alerter = {
      notify: () => {
        throw new Error('telegram down')
      },
      flush: async () => {},
    }
    const o2 = new PriceOracleImpl({
      pumpMint: PUMP,
      sources: [throwsSync],
      poolPrice: async () => 0n, // non-positive pool price is a failure, not a price
      cacheSeconds: 30,
      store: brokenStore,
      alerter: throwingAlerter,
      now: () => new Date(clock),
    })
    await expect(o2.get()).resolves.toMatchObject({ state: 'none' })
  })

  it('computes SCRATCHY/USD = floor(scratchyPump × pumpUsd / 1e18) exactly', async () => {
    const cases: Array<[pumpUsd: string, scratchyPumpE18: bigint, expected: bigint]> = [
      ['0.0056652589', 123_456_789n * 10n ** 15n, 699_414_672_647_672_100_000n], // 123456.789 PUMP
      ['0.0056652589', 12_300_000_000_000n, 69_682_684_470n], // 0.0000123 PUMP
      ['3', E18 / 3n, 999_999_999_999_999_999n], // (1/3 PUMP floored) × $3 — floors, never rounds up
      ['0.000000000000000001', 1n, 0n], // below resolution floors to zero
    ]
    for (const [usd, scratchyPump, expected] of cases) {
      const h = harness({ sources: [new MockUsdSource(usd, 'jupiter')] })
      h.pool.priceE18 = scratchyPump
      const snap = await h.oracle.get()
      expect(snap.scratchyUsd?.valueE18, `${usd} × ${scratchyPump}`).toBe(expected)
      expect(snap.scratchyUsd?.source).toBe('pool*jupiter')
    }
  })

  it('background refresh keeps peek() fresh', async () => {
    const h = harness()
    h.oracle.start()
    await new Promise((r) => setTimeout(r, 10))
    h.oracle.stop()
    expect(h.oracle.peek().state).toBe('fresh')
    expect(h.jup.calls).toBe(1)
  })

  it('reads SCRATCHY/PUMP from the venue pool state', async () => {
    const venue = { getPoolState: async () => ({ priceQuotePerBaseE18: 42n * E18 }) }
    expect(await poolPriceFromVenue(venue as never)()).toBe(42n * E18)
  })

  it('rejects a non-positive cache window', () => {
    expect(() => harness({ cacheSeconds: 0 })).toThrow(/cacheSeconds/)
  })
})

// ---------------------------------------------------------------------------------------------- DB store

describe('DbPricesStore (Postgres)', () => {
  let database: Database | null = null
  afterEach(async () => {
    await database?.close()
    database = null
  })

  it('upserts, never lets an older quote overwrite a newer one, and round-trips bigints exactly', async () => {
    database = await freshDatabase()
    const store = new DbPricesStore(database.db)
    const big = 123_456_789_012_345_678_901_234_567_890n
    await store.save('k', { valueE18: 5n, source: 'jupiter', at: new Date(T0) })
    await store.save('k', { valueE18: big, source: 'dexscreener', at: new Date(T0 + 1_000) })
    await store.save('k', { valueE18: 7n, source: 'stale-writer', at: new Date(T0 - 1_000) })
    await store.save('other', { valueE18: 1n, source: 'pool', at: new Date(T0) })
    const loaded = await store.load()
    expect(loaded.get('k')).toEqual({ valueE18: big, source: 'dexscreener', at: new Date(T0 + 1_000) })
    expect(loaded.get('other')).toEqual({ valueE18: 1n, source: 'pool', at: new Date(T0) })
  })

  it('carries the last known prices across an oracle restart', async () => {
    database = await freshDatabase()
    const store = new DbPricesStore(database.db)
    const first = harness({ store })
    await first.oracle.get()
    for (let i = 0; i < 100 && (await store.load()).size < 2; i++) await new Promise((r) => setTimeout(r, 20)) // saves are fire-and-forget

    clock = T0 + 600_000
    const dead = new MockUsdSource('1', 'jupiter')
    dead.setFailing(true)
    const restarted = new PriceOracleImpl({
      pumpMint: PUMP,
      sources: [dead],
      poolPrice: async () => {
        throw new Error('rpc down')
      },
      cacheSeconds: 30,
      store: new DbPricesStore(database.db),
      now: () => new Date(clock),
    })
    const snap = await restarted.get()
    expect(snap.state).toBe('frozen')
    expect(snap.pumpUsd).toEqual({ valueE18: 5_665_258_900_000_000n, source: 'jupiter', at: new Date(T0) })
    expect(snap.scratchyUsd?.valueE18).toBe(2_832_629_450_000_000n)
  })
})
