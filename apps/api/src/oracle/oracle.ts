import { mulPriceE18, scaledToDecimal } from '@scratchy/core'
import type { Alerter } from '../alerts/types'
import type { RuntimeEnv } from '../env'
import type { VenueAdapter } from '../venue/types'
import { DexScreenerUsdSource } from './dexscreener'
import { JupiterUsdSource, type FetchFn } from './jupiter'
import { MockUsdSource } from './mock'
import type { PricesStore } from './store'
import type { PriceOracle, PriceQuote, PriceSnapshot, PriceState, UsdPriceSource } from './types'

/**
 * The dual price oracle (PLAN §3). Two live prices, cached for PRICE_CACHE_SECONDS:
 *  - PUMP/USD      — from the configured USD sources, tried in order (Jupiter → DexScreener on mainnet,
 *                    a fixed mock on devnet); the source that answered is recorded on the quote.
 *  - SCRATCHY/PUMP — from the venue's pool (DAMM v2 sqrtPrice), via the injected `poolPrice`.
 *  - SCRATCHY/USD  — derived: floor(scratchyPump × pumpUsd / 1e18), exact bigint math.
 *
 * States (see ./types): 'fresh' when the last refresh got both prices live; 'stale' when a refresh failed
 * (or has not run lately) but the oldest last-live value is younger than 5 × PRICE_CACHE_SECONDS; beyond
 * that 'frozen' — eligibility stays at the last known price and the site shows a banner, while payouts
 * carry on (they are PUMP-denominated). 'none' until both prices have been known at least once.
 * Invariant for consumers: state !== 'none' ⇒ pumpUsd, scratchyPump and scratchyUsd are all non-null.
 *
 * Every live value is persisted (PricesStore) and reloaded at startup, so a restart during an outage
 * resumes 'frozen' at the last known price rather than failing closed as 'none'. Entering 'frozen' (or a
 * failed cold start) and recovering to 'fresh' are alerted. get() is single-flight and never throws.
 */

export const FROZEN_AFTER_CACHE_MULTIPLE = 5
/** safety net around every source call (the HTTP sources carry their own 5 s timeout) */
export const ORACLE_CALL_TIMEOUT_MS = 10_000

export const pumpUsdKey = (mint: string): string => `pump_usd:${mint}`
export const DEFAULT_SCRATCHY_PUMP_KEY = 'scratchy_pump'

/** pino-compatible subset (pass `app.log`) */
export interface OracleLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

export interface PriceOracleOptions {
  /** the mint whose USD price the sources are asked for (PUMP_PRICE_MINT — real PUMP even on devnet) */
  pumpMint: string
  /** PUMP/USD sources, tried in order until one returns a price */
  sources: UsdPriceSource[]
  /** SCRATCHY priced in PUMP × 1e18, from the venue (see poolPriceFromVenue) */
  poolPrice: () => Promise<bigint>
  /** PRICE_CACHE_SECONDS */
  cacheSeconds: number
  store: PricesStore
  alerter?: Alerter
  now?: () => Date
  logger?: OracleLogger
  /** recorded as the SCRATCHY/PUMP quote's source (default 'pool') */
  poolSourceName?: string
  /** persistence key for SCRATCHY/PUMP (default 'scratchy_pump'; e.g. include the pool address) */
  scratchyPumpKey?: string
  /** default 5 × cacheSeconds */
  frozenAfterSeconds?: number
  callTimeoutMs?: number
}

export class PriceOracleImpl implements PriceOracle {
  private readonly now: () => Date
  private readonly cacheMs: number
  private readonly freshMs: number
  private readonly frozenAfterMs: number
  private readonly callTimeoutMs: number
  private readonly pumpKey: string
  private readonly scratchyKey: string
  private readonly poolSourceName: string

  private pumpUsd: PriceQuote | null = null
  private scratchyPump: PriceQuote | null = null
  /** did the most recent refresh obtain each price live? */
  private pumpLive = false
  private poolLive = false
  private lastFreshAt: Date | null = null
  private lastAttemptAtMs: number | null = null
  private lastErrors: string[] = []

  private inflight: Promise<void> | null = null
  private loading: Promise<void> | null = null
  private loaded = false

  private lastState: PriceState | null = null
  /** a frozen/unavailable alert went out and no recovery alert has followed yet */
  private degraded = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly o: PriceOracleOptions) {
    if (!(o.cacheSeconds > 0)) throw new RangeError(`cacheSeconds must be > 0 (got ${o.cacheSeconds})`)
    this.now = o.now ?? (() => new Date())
    this.cacheMs = o.cacheSeconds * 1000
    // a fresh snapshot stays fresh through the next cache window, so the refresh that is running (or a
    // background tick that fires a little late) never flaps the site banner to 'stale'
    this.freshMs = 2 * this.cacheMs
    this.frozenAfterMs = (o.frozenAfterSeconds ?? FROZEN_AFTER_CACHE_MULTIPLE * o.cacheSeconds) * 1000
    this.callTimeoutMs = o.callTimeoutMs ?? ORACLE_CALL_TIMEOUT_MS
    this.pumpKey = pumpUsdKey(o.pumpMint)
    this.scratchyKey = o.scratchyPumpKey ?? DEFAULT_SCRATCHY_PUMP_KEY
    this.poolSourceName = o.poolSourceName ?? 'pool'
  }

  /** load persisted prices so peek() has the last known values before the first get() */
  async init(): Promise<void> {
    await this.ensureLoaded()
  }

  async get(): Promise<PriceSnapshot> {
    try {
      await this.ensureLoaded()
      if (this.inflight) await this.inflight
      else if (this.refreshDue()) await this.refreshShared()
    } catch (err) {
      this.warn(err, 'price oracle refresh failed')
    }
    const snap = this.peek()
    this.track(snap)
    return snap
  }

  peek(): PriceSnapshot {
    const nowMs = this.now().getTime()
    const pumpUsd = this.pumpUsd
    const scratchyPump = this.scratchyPump
    let scratchyUsd: PriceQuote | null = null
    if (pumpUsd && scratchyPump) {
      scratchyUsd = {
        valueE18: mulPriceE18(scratchyPump.valueE18, pumpUsd.valueE18),
        source: `${scratchyPump.source}*${pumpUsd.source}`,
        at: new Date(Math.min(pumpUsd.at.getTime(), scratchyPump.at.getTime())),
      }
    }
    return {
      pumpUsd: copyQuote(pumpUsd),
      scratchyPump: copyQuote(scratchyPump),
      scratchyUsd,
      state: this.stateAt(nowMs),
      lastFreshAt: this.lastFreshAt ? new Date(this.lastFreshAt) : null,
    }
  }

  /** background refresh every cacheSeconds (keeps peek() fresh for the websocket / banner) */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.cacheMs)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    try {
      await this.ensureLoaded()
      await this.refreshShared()
    } catch (err) {
      this.warn(err, 'price oracle background refresh failed')
    }
    this.track(this.peek())
  }

  private refreshDue(): boolean {
    if (this.lastAttemptAtMs === null) return true
    const nowMs = this.now().getTime()
    return nowMs - this.lastAttemptAtMs >= this.cacheMs || nowMs < this.lastAttemptAtMs
  }

  /** single-flight: every concurrent caller shares one refresh */
  private refreshShared(): Promise<void> {
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async refresh(): Promise<void> {
    this.lastAttemptAtMs = this.now().getTime()
    const pumpErrors: string[] = []
    const poolErrors: string[] = []
    const [pump, pool] = await Promise.all([
      this.fetchPumpUsd(pumpErrors),
      this.fetchScratchyPump(poolErrors),
    ])
    const at = this.now()
    this.lastErrors = [...pumpErrors, ...poolErrors]
    this.pumpLive = pump !== null
    this.poolLive = pool !== null
    if (pump) {
      this.pumpUsd = { valueE18: pump.valueE18, source: pump.source, at }
      this.persist(this.pumpKey, this.pumpUsd)
    }
    if (pool !== null) {
      this.scratchyPump = { valueE18: pool, source: this.poolSourceName, at }
      this.persist(this.scratchyKey, this.scratchyPump)
    }
    if (pump && pool !== null) {
      this.lastFreshAt = at
      this.loaded = true // both live: persisted values can no longer matter
    }
  }

  private async fetchPumpUsd(errors: string[]): Promise<{ valueE18: bigint; source: string } | null> {
    for (const src of this.o.sources) {
      try {
        const v = await withTimeout(src.fetchUsdPriceE18(this.o.pumpMint), this.callTimeoutMs, src.name)
        if (typeof v === 'bigint' && v > 0n) return { valueE18: v, source: src.name }
        errors.push(`${src.name}: no price`)
      } catch (err) {
        errors.push(`${src.name}: ${errMsg(err)}`)
        this.warn(err, `PUMP/USD source ${src.name} failed`)
      }
    }
    return null
  }

  private async fetchScratchyPump(errors: string[]): Promise<bigint | null> {
    try {
      const v = await withTimeout(this.o.poolPrice(), this.callTimeoutMs, this.poolSourceName)
      if (typeof v === 'bigint' && v > 0n) return v
      errors.push(`${this.poolSourceName}: non-positive price ${String(v)}`)
    } catch (err) {
      errors.push(`${this.poolSourceName}: ${errMsg(err)}`)
      this.warn(err, 'SCRATCHY/PUMP pool price failed')
    }
    return null
  }

  private stateAt(nowMs: number): PriceState {
    if (!this.pumpUsd || !this.scratchyPump) return 'none'
    const age = nowMs - Math.min(this.pumpUsd.at.getTime(), this.scratchyPump.at.getTime())
    if (age >= this.frozenAfterMs) return 'frozen'
    if (this.pumpLive && this.poolLive && age < this.freshMs) return 'fresh'
    return 'stale'
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.loadPersisted().finally(() => {
      this.loading = null
    })
    await this.loading
  }

  private async loadPersisted(): Promise<void> {
    try {
      const saved = await withTimeout(this.o.store.load(), this.callTimeoutMs, 'price store load')
      const nowMs = this.now().getTime()
      this.pumpUsd = newer(this.pumpUsd, saved.get(this.pumpKey), nowMs)
      this.scratchyPump = newer(this.scratchyPump, saved.get(this.scratchyKey), nowMs)
      if (this.lastFreshAt === null && this.pumpUsd && this.scratchyPump) {
        this.lastFreshAt = new Date(Math.min(this.pumpUsd.at.getTime(), this.scratchyPump.at.getTime()))
      }
      this.loaded = true
    } catch (err) {
      this.warn(err, 'could not load persisted prices (will retry)')
    }
  }

  private persist(key: string, quote: PriceQuote): void {
    try {
      this.o.store.save(key, quote).catch((err: unknown) => this.warn(err, `could not persist price ${key}`))
    } catch (err) {
      this.warn(err, `could not persist price ${key}`)
    }
  }

  private track(snap: PriceSnapshot): void {
    const prev = this.lastState
    this.lastState = snap.state
    if (snap.state === prev) return
    const data = this.alertData(snap)
    if (snap.state === 'frozen') {
      this.degraded = true
      this.alert({
        kind: 'oracle_frozen',
        severity: 'critical',
        message:
          `Price oracle FROZEN: no live price for ≥ ${Math.round(this.frozenAfterMs / 1000)}s. ` +
          'Eligibility is frozen at the last known price (site banner on); payouts continue in PUMP.',
        data,
        immediate: true,
        dedupeKey: 'oracle_frozen',
      })
    } else if (snap.state === 'none') {
      this.degraded = true
      this.alert({
        kind: 'oracle_unavailable',
        severity: 'critical',
        message:
          'Price oracle has no price at all (cold start, every source failing): reserve check fails closed.',
        data,
        immediate: true,
        dedupeKey: 'oracle_unavailable',
      })
    } else if (snap.state === 'fresh' && this.degraded) {
      this.degraded = false
      this.alert({
        kind: 'oracle_recovered',
        severity: 'info',
        message: 'Price oracle recovered: live prices again, eligibility unfrozen.',
        data,
        immediate: true,
        dedupeKey: 'oracle_recovered',
      })
    }
  }

  private alertData(snap: PriceSnapshot): Record<string, unknown> {
    return {
      pumpUsd: snap.pumpUsd ? scaledToDecimal(snap.pumpUsd.valueE18, 18) : null,
      pumpUsdSource: snap.pumpUsd?.source ?? null,
      scratchyPump: snap.scratchyPump ? scaledToDecimal(snap.scratchyPump.valueE18, 18) : null,
      scratchyUsd: snap.scratchyUsd ? scaledToDecimal(snap.scratchyUsd.valueE18, 18) : null,
      lastFreshAt: snap.lastFreshAt?.toISOString() ?? null,
      errors: [...this.lastErrors],
    }
  }

  private alert(event: Parameters<Alerter['notify']>[0]): void {
    try {
      this.o.alerter?.notify(event)
    } catch (err) {
      this.warn(err, 'alerter.notify threw')
    }
  }

  private warn(err: unknown, msg: string): void {
    try {
      this.o.logger?.warn({ err: errMsg(err) }, msg)
    } catch {
      // logging must never break the oracle
    }
  }
}

/** PUMP/USD sources for the configured PRICE_SOURCE: live → [Jupiter, DexScreener], mock → [MOCK_PUMP_USD]. */
export function createUsdSources(
  env: Pick<
    RuntimeEnv,
    'PRICE_SOURCE' | 'JUPITER_API_BASE' | 'JUPITER_API_KEY' | 'DEXSCREENER_API_BASE' | 'MOCK_PUMP_USD'
  >,
  fetchImpl?: FetchFn,
): UsdPriceSource[] {
  if (env.PRICE_SOURCE === 'mock') return [new MockUsdSource(env.MOCK_PUMP_USD)]
  return [
    new JupiterUsdSource(env.JUPITER_API_BASE, env.JUPITER_API_KEY, fetchImpl),
    new DexScreenerUsdSource(env.DEXSCREENER_API_BASE, fetchImpl),
  ]
}

/** SCRATCHY/PUMP × 1e18 straight from the venue's pool state (DAMM v2: from sqrtPrice). */
export function poolPriceFromVenue(venue: Pick<VenueAdapter, 'getPoolState'>): () => Promise<bigint> {
  return async () => (await venue.getPoolState()).priceQuotePerBaseE18
}

function newer(current: PriceQuote | null, saved: PriceQuote | undefined, nowMs: number): PriceQuote | null {
  if (!saved || saved.valueE18 <= 0n) return current
  // never trust a future timestamp (clock skew) — it would keep a dead price 'stale' indefinitely
  const at = new Date(Math.min(saved.at.getTime(), nowMs))
  if (current && current.at.getTime() >= at.getTime()) return current
  return { valueE18: saved.valueE18, source: saved.source, at }
}

function copyQuote(q: PriceQuote | null): PriceQuote | null {
  return q ? { valueE18: q.valueE18, source: q.source, at: new Date(q.at) } : null
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
