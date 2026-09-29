import { DEFAULT_ECONOMY } from '@scratchy/core'
import bs58 from 'bs58'
import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DbEventsSink, MemoryEventsSink, type EventsSink } from '../src/alerts/events-sink'
import { alertLabel, createAlerter } from '../src/alerts/index'
import { TelegramAlerter, type AlertLogger } from '../src/alerts/telegram'
import type { AlertEvent, Alerter } from '../src/alerts/types'
import { MemoryChainClient } from '../src/chain/memory'
import { events } from '../src/db/schema'
import { WalletMonitor } from '../src/monitor/wallet-monitor'
import { freshDatabase } from './helpers/db'

// ── helpers ──────────────────────────────────────────────────────────────────

const TOKEN = '123456789:AAHfakeFakeFakeFakeFakeFakeFakeFake_0'
const CHAT = '-1001234567890'

interface SentMessage {
  at: number
  url: string
  body: { chat_id: string; text: string; parse_mode?: string; disable_web_page_preview?: boolean }
}

type FakeResponse = 'throw' | { status: number; body: unknown }

/** injected fetch that records every Telegram call; `responses` scripts the next answers (default 200 ok) */
function fakeTelegram() {
  const sent: SentMessage[] = []
  const responses: FakeResponse[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ at: Date.now(), url: String(url), body: JSON.parse(String(init?.body)) })
    const r = responses.shift()
    if (r === 'throw') throw new Error('fetch failed: ECONNRESET')
    const status = r?.status ?? 200
    const payload = r?.body ?? { ok: true, result: { message_id: sent.length } }
    return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response
  }) as typeof fetch
  return { sent, responses, fetchImpl }
}

function recordingLogger() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = []
  const logger: AlertLogger = {
    info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => lines.push({ level: 'error', obj, msg }),
  }
  return { lines, logger }
}

/** let queued microtasks + zero-delay fake timers run */
async function settle() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

function alerter(
  tg: ReturnType<typeof fakeTelegram>,
  sink: EventsSink,
  logger: AlertLogger,
  digestSeconds = 5,
) {
  return new TelegramAlerter({
    botToken: TOKEN,
    chatId: CHAT,
    digestSeconds,
    sink,
    fetchImpl: tg.fetchImpl,
    logger,
    label: 'devnet·test',
  })
}

const immediate = (message: string, extra: Partial<AlertEvent> = {}): AlertEvent => ({
  kind: 'test.alert',
  severity: 'warn',
  message,
  immediate: true,
  ...extra,
})

// ── Telegram alerter ─────────────────────────────────────────────────────────

describe('TelegramAlerter', () => {
  let tg: ReturnType<typeof fakeTelegram>
  let sink: MemoryEventsSink
  let log: ReturnType<typeof recordingLogger>
  let a: TelegramAlerter

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-29T12:00:00Z') })
    tg = fakeTelegram()
    sink = new MemoryEventsSink()
    log = recordingLogger()
    a = alerter(tg, sink, log.logger)
  })

  afterEach(async () => {
    await a.close()
    vi.useRealTimers()
  })

  it('batches non-immediate events into one digest every digestSeconds', async () => {
    for (let i = 1; i <= 12; i++) {
      a.notify({
        kind: 'payout.confirmed',
        severity: 'info',
        message: `payout #${i} confirmed`,
        data: { amountRaw: 266_666_666_666n, payoutId: BigInt(i) },
      })
    }
    a.notify({
      kind: 'sweep.done',
      severity: 'info',
      message: 'sweep #3 split 70/30',
      data: { amountRaw: 1_100_000_000n },
    })
    await settle()
    expect(tg.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(tg.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(tg.sent).toHaveLength(1)
    const text = tg.sent[0]!.body.text
    expect(text).toContain('[devnet·test] <b>Digest</b> · 13 events')
    expect(text).toContain('🎫 12 payouts confirmed: 3.2M PUMP total')
    expect(text).toContain('🧹 1 sweep done: 1.1K PUMP total')
    // up to 10 lines, then a count of the rest
    expect(text).toContain('payout #10 confirmed')
    expect(text).not.toContain('payout #11 confirmed')
    expect(text).toContain('…and 3 more')
    // every event is persisted individually, bigints as decimal strings
    expect(sink.events).toHaveLength(13)
    expect(sink.events[0]!.data).toMatchObject({ amountRaw: '266666666666', payoutId: '1' })

    // a new digest window starts with the next event
    a.notify({
      kind: 'payout.confirmed',
      severity: 'info',
      message: 'payout #13 confirmed',
      data: { amountRaw: 5_000_000n },
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(tg.sent).toHaveLength(2)
    expect(tg.sent[1]!.body.text).toContain('🎫 1 payout confirmed: 5 PUMP total')
  })

  it('keeps warnings visible in a digest and uses generic labels for other kinds', async () => {
    for (let i = 0; i < 12; i++) a.notify({ kind: 'payout.confirmed', severity: 'info', message: `ok ${i}` })
    a.notify({ kind: 'payout.worker_error', severity: 'warn', message: 'worker tick failed: timeout' })
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    const text = tg.sent[0]!.body.text
    expect(text).toContain('1× payout.worker_error')
    expect(text).toContain('⚠️ worker tick failed: timeout')
  })

  it('sends immediate events at once, HTML-escaped, with the right request shape', async () => {
    a.notify({ kind: 'payout.confirmed', severity: 'info', message: 'routine (digest)' })
    a.notify({
      kind: 'payout.failed_permanent',
      severity: 'critical',
      message: 'payout #7 <b>frozen</b> & "stuck"',
      immediate: true,
      data: { payoutId: 7n, wallet: 'Alice111111111111111111111111111111111111111' },
    })
    await settle()
    expect(tg.sent).toHaveLength(1)
    const s = tg.sent[0]!
    expect(s.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(s.body).toMatchObject({ chat_id: CHAT, parse_mode: 'HTML', disable_web_page_preview: true })
    expect(s.body.text).toContain('[devnet·test] 🚨 <b>CRITICAL</b> · payout.failed_permanent')
    expect(s.body.text).toContain('payout #7 &lt;b&gt;frozen&lt;/b&gt; &amp; &quot;stuck&quot;')
    expect(s.body.text).toContain('payoutId: 7')
    expect(s.body.text).not.toContain('routine (digest)')
  })

  it('suppresses repeats of a dedupeKey for 10 minutes on Telegram only; state changes go through', async () => {
    const paused = (i: number) =>
      immediate(`low gas #${i}`, {
        kind: 'monitor.low_gas.paused',
        severity: 'critical',
        dedupeKey: 'monitor.low_gas',
      })
    for (let i = 0; i < 5; i++) a.notify(paused(i))
    await settle()
    expect(tg.sent).toHaveLength(1)
    expect(sink.events).toHaveLength(5) // still persisted
    expect(log.lines.filter((l) => l.obj.alert === 'monitor.low_gas.paused')).toHaveLength(5) // still logged

    await vi.advanceTimersByTimeAsync(9 * 60_000)
    a.notify(paused(5))
    await settle()
    expect(tg.sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    a.notify(paused(6))
    await settle()
    expect(tg.sent).toHaveLength(2)
    expect(tg.sent[1]!.body.text).toContain('low gas #6')
    expect(tg.sent[1]!.body.text).toContain('(+5 similar suppressed in the last 10 min)')

    // a different kind under the same key (paused → resumed) is never suppressed
    a.notify(
      immediate('gas ok', {
        kind: 'monitor.low_gas.resumed',
        severity: 'info',
        dedupeKey: 'monitor.low_gas',
      }),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(tg.sent).toHaveLength(3)
    expect(tg.sent[2]!.body.text).toContain('gas ok')

    // escalation (same kind, higher severity) goes through too
    a.notify(
      immediate('worse', {
        kind: 'monitor.low_gas.resumed',
        severity: 'critical',
        dedupeKey: 'monitor.low_gas',
      }),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(tg.sent).toHaveLength(4)
  })

  it('dedupes digest events too', async () => {
    for (let i = 0; i < 4; i++) {
      a.notify({
        kind: 'payout.worker_error',
        severity: 'warn',
        message: 'tick failed',
        dedupeKey: 'payout.worker_error',
      })
    }
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.body.text).toContain('1 event')
    expect(sink.events).toHaveLength(4)
  })

  it('merges a synchronous burst of immediate events into one message', async () => {
    for (let i = 0; i < 30; i++) a.notify(immediate(`burst-${i}-end`))
    await settle()
    expect(tg.sent).toHaveLength(1)
    for (let i = 0; i < 30; i++) expect(tg.sent[0]!.body.text).toContain(`burst-${i}-end`)
  })

  it('splits merged overflow at the Telegram size limit and paces the parts ≥ 1s apart', async () => {
    const filler = 'lorem ipsum '.repeat(84) // ~1,000 chars of ordinary (non-secret-looking) text
    for (let i = 0; i < 12; i++) a.notify(immediate(`big-${i}-end ${filler}`))
    await settle()
    expect(tg.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(tg.sent.length).toBeGreaterThan(1)
    for (const s of tg.sent) expect(s.body.text.length).toBeLessThanOrEqual(4_096)
    for (let i = 1; i < tg.sent.length; i++)
      expect(tg.sent[i]!.at - tg.sent[i - 1]!.at).toBeGreaterThanOrEqual(1_000)
    const all = tg.sent.map((s) => s.body.text).join('\n')
    for (let i = 0; i < 12; i++) expect(all).toContain(`big-${i}-end`)
  })

  it('rate-limits to ≤ 1 msg/s and ≤ 18 msgs/min, merging the overflow into later messages', async () => {
    for (let i = 0; i < 60; i++) {
      a.notify(immediate(`alert-${i}-end`))
      await vi.advanceTimersByTimeAsync(500)
    }
    await vi.advanceTimersByTimeAsync(180_000)
    await settle()
    const at = tg.sent.map((s) => s.at)
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(1_000)
    for (const start of at) {
      expect(at.filter((t) => t >= start && t < start + 60_000).length).toBeLessThanOrEqual(18)
    }
    expect(at.length).toBeLessThan(60) // overflow was merged
    const all = tg.sent.map((s) => s.body.text).join('\n')
    for (let i = 0; i < 60; i++) expect(all).toContain(`alert-${i}-end`)
  })

  it('redacts secret material from Telegram text, the sink and the log', async () => {
    const secret = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256)
    const byteJson = JSON.stringify(Array.from(secret))
    let b58 = ''
    while (b58.length !== 88) b58 = bs58.encode(randomBytes(64))
    const bufDump = inspect(Buffer.from(secret))
    a.notify({
      kind: 'ops.misconfig',
      severity: 'critical',
      immediate: true,
      message: `loaded ${byteJson} / ${b58} / ${bufDump} / token ${TOKEN}`,
      data: {
        secretKey: Array.from(secret),
        bytes: secret,
        note: `key=${b58}`,
        nested: { list: [Array.from(secret)], PRIZE_WALLET_KEY: 'whatever-it-is' },
        amountRaw: 5n,
      },
    })
    await settle()
    await a.flush()
    expect(tg.sent).toHaveLength(1)
    const body = JSON.stringify(tg.sent[0]!.body)
    const persisted = JSON.stringify(sink.events)
    const logged = JSON.stringify(log.lines)
    for (const needle of [
      b58,
      b58.slice(10, 50),
      byteJson,
      byteJson.slice(1, 40),
      TOKEN,
      'whatever-it-is',
      '0b 30 55',
    ]) {
      expect(body).not.toContain(needle)
      expect(persisted).not.toContain(needle)
      expect(logged).not.toContain(needle)
    }
    expect(tg.sent[0]!.body.text).toContain('[REDACTED]')
    expect(sink.events[0]!.data).toMatchObject({
      amountRaw: '5',
      bytes: '[64 bytes]',
      secretKey: '[REDACTED]',
    })
  })

  it('always writes the sink, retries a failed send once, then drops it (never throws)', async () => {
    tg.responses.push('throw', 'throw')
    expect(() =>
      a.notify(immediate('breaker tripped', { kind: 'breaker.tripped', severity: 'critical' })),
    ).not.toThrow()
    await settle()
    expect(tg.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(tg.sent).toHaveLength(2) // one retry
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    expect(tg.sent).toHaveLength(2) // then dropped
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]!.kind).toBe('breaker.tripped')
    expect(log.lines.some((l) => l.level === 'error' && l.msg.includes('dropped'))).toBe(true)
    await expect(a.flush()).resolves.toBeUndefined()
  })

  it('honours 429 retry_after and retries a 400 as plain text', async () => {
    tg.responses.push({
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 7',
        parameters: { retry_after: 7 },
      },
    })
    a.notify(immediate('first'))
    await settle()
    expect(tg.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(6_900)
    expect(tg.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    await settle()
    expect(tg.sent).toHaveLength(2)
    expect(tg.sent[1]!.body.text).toContain('first')

    tg.responses.push({ status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } })
    a.notify(immediate('<odd> & markup'))
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(tg.sent).toHaveLength(4)
    const retry = tg.sent[3]!.body
    expect(retry.parse_mode).toBeUndefined()
    expect(retry.text).toContain('<odd> & markup')
    expect(retry.text).not.toContain('<b>')
  })

  it('keeps delivering to Telegram when the sink fails', async () => {
    const failing: EventsSink = {
      write: () => {
        throw new Error('db down')
      },
    }
    const b = alerter(tg, failing, log.logger)
    expect(() => b.notify(immediate('still delivered'))).not.toThrow()
    await settle()
    await b.close()
    expect(tg.sent.some((s) => s.body.text.includes('still delivered'))).toBe(true)
    expect(log.lines.some((l) => l.obj.alert === 'alerts.sink_error')).toBe(true)
  })

  it('flush() sends the pending digest immediately', async () => {
    a.notify({
      kind: 'payout.confirmed',
      severity: 'info',
      message: 'pending',
      data: { amountRaw: 1_000_000n },
    })
    await a.flush()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.body.text).toContain('🎫 1 payout confirmed: 1 PUMP total')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tg.sent).toHaveLength(1)
  })

  it('never throws on hostile input', async () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() =>
      a.notify({
        kind: 'x',
        severity: 'bogus' as never,
        message: 'cyclic',
        data: { cyclic, fn: () => 1, sym: Symbol('s'), big: 10n ** 30n, nan: Number.NaN, when: new Date(0) },
        immediate: true,
      }),
    ).not.toThrow()
    await a.flush()
    expect(sink.events[0]).toMatchObject({
      severity: 'warn',
      data: {
        cyclic: { a: 1, self: '[circular]' },
        big: (10n ** 30n).toString(),
        nan: 'NaN',
        when: '1970-01-01T00:00:00.000Z',
      },
    })
  })
})

describe('createAlerter', () => {
  it('is log + sink only when Telegram is not fully configured', async () => {
    const tg = fakeTelegram()
    const sink = new MemoryEventsSink()
    const log = recordingLogger()
    const a = createAlerter(
      { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: CHAT, TELEGRAM_DIGEST_SECONDS: 5 },
      sink,
      { logger: log.logger, fetchImpl: tg.fetchImpl },
    )
    expect(a.enabled).toBe(false)
    a.notify(immediate('only logged', { severity: 'critical' }))
    a.notify({ kind: 'payout.confirmed', severity: 'info', message: 'digest item' })
    await a.close()
    expect(tg.sent).toHaveLength(0)
    expect(sink.events).toHaveLength(2)
    expect(log.lines.some((l) => l.level === 'warn' && l.msg.includes('must both be set'))).toBe(true)
    expect(log.lines.some((l) => l.level === 'error' && l.msg === 'only logged')).toBe(true)
  })

  it('delivers to Telegram when both token and chat id are set', async () => {
    const tg = fakeTelegram()
    const a = createAlerter(
      {
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_CHAT_ID: CHAT,
        TELEGRAM_DIGEST_SECONDS: 5,
        CHAIN_MODE: 'solana',
        SOLANA_CLUSTER: 'devnet',
        DEPLOY_ID: 'local',
      },
      new MemoryEventsSink(),
      { logger: recordingLogger().logger, fetchImpl: tg.fetchImpl },
    )
    expect(a.enabled).toBe(true)
    a.notify(immediate('hello'))
    await a.close()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.body.text).toContain('[devnet·local]')
    expect(alertLabel({ CHAIN_MODE: 'memory', SOLANA_CLUSTER: 'devnet', DEPLOY_ID: 'x' })).toBe('memory·x')
  })
})

describe('DbEventsSink', () => {
  it('inserts kind/severity/message/data with bigints as strings and secrets redacted', async () => {
    const database = await freshDatabase()
    try {
      const sink = new DbEventsSink(database.db)
      await sink.write({
        kind: 'sweep.done',
        severity: 'info',
        message: 'swept',
        data: { toPrizeRaw: 700n, toOpsRaw: 300n, sigs: ['abc'], secretKey: [1, 2, 3] },
      })
      await sink.write({ kind: 'monitor.low_gas.paused', severity: 'critical', message: 'no data' })
      const rows = await database.db.select().from(events).orderBy(events.id)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ kind: 'sweep.done', severity: 'info', message: 'swept' })
      expect(rows[0]!.data).toEqual({
        toPrizeRaw: '700',
        toOpsRaw: '300',
        sigs: ['abc'],
        secretKey: '[REDACTED]',
      })
      expect(rows[1]!.data).toBeNull()
    } finally {
      await database.close()
    }
  })
})

// ── wallet monitor ───────────────────────────────────────────────────────────

const PRIZE = 'PrizeWallet1111111111111111111111111111111'
const CREATOR = 'CreatorWallet111111111111111111111111111111'
const MINT = 'MockPump11111111111111111111111111111111111'
const SOL = 1_000_000_000n
const PUMP = 1_000_000n
/** $0.005 per PUMP → MIN_POOL_RESERVE_USD $300 = 60,000 PUMP */
const PRICE_E18 = 5_000_000_000_000_000n

class RecordingAlerter implements Alerter {
  events: AlertEvent[] = []
  notify(e: AlertEvent) {
    this.events.push(e)
  }
  async flush() {}
  kinds() {
    return this.events.map((e) => e.kind)
  }
  clear() {
    this.events = []
  }
}

function monitorSetup(opts: { price?: bigint | null; alerter?: Alerter; creator?: string | null } = {}) {
  const creator = opts.creator === undefined ? CREATOR : opts.creator
  const chain = new MemoryChainClient({
    prizeAddress: PRIZE,
    creatorAddress: creator,
    mints: [{ address: MINT, decimals: 6, token2022: true }],
  })
  const rec = new RecordingAlerter()
  const ctl = {
    price: (opts.price === undefined ? PRICE_E18 : opts.price) as bigint | null,
    reserved: { jackpotRaw: 0n, outstandingRaw: 0n },
    reservedCalls: 0,
    changes: 0,
  }
  const monitor = new WalletMonitor({
    chain,
    prizeAddress: PRIZE,
    creatorAddress: creator,
    pumpMint: MINT,
    economy: DEFAULT_ECONOMY,
    minCreatorGasLamports: SOL / 20n, // 0.05 SOL
    hysteresisPpm: 100_000n, // 10%
    getPumpUsdE18: () => ctl.price,
    getReservedRaw: async () => {
      ctl.reservedCalls++
      return ctl.reserved
    },
    alerter: opts.alerter ?? rec,
    onChange: () => {
      ctl.changes++
    },
  })
  // healthy defaults: 1 SOL gas each, 100k PUMP (finalized)
  chain.setSol(PRIZE, SOL)
  if (creator) chain.setSol(creator, SOL)
  chain.credit(PRIZE, MINT, 100_000n * PUMP)
  chain.advance(3)
  return { chain, rec, ctl, monitor }
}

describe('WalletMonitor', () => {
  it('is fail-closed before the first check and quiet when healthy', async () => {
    const { monitor, rec } = monitorSetup()
    expect(monitor.state()).toMatchObject({ lowGas: true, lowPool: true, checkedAt: null })
    const s = await monitor.check()
    expect(s).toMatchObject({
      lowGas: false,
      lowPool: false,
      creatorGasLow: false,
      prizeSolLamports: SOL,
      prizePumpRaw: 100_000n * PUMP,
      poolRaw: 100_000n * PUMP,
      reserveRaw: 60_000n * PUMP,
      creatorSolLamports: SOL,
    })
    expect(s.checkedAt).toBeInstanceOf(Date)
    expect(rec.events).toHaveLength(0)
  })

  it('pauses on low gas and resumes only past the hysteresis band', async () => {
    const { monitor, rec, chain, ctl } = monitorSetup()
    await monitor.check()
    ctl.changes = 0

    chain.setSol(PRIZE, SOL / 20n) // 0.05 < 0.1
    expect((await monitor.check()).lowGas).toBe(true)
    expect(rec.events).toHaveLength(1)
    expect(rec.events[0]).toMatchObject({
      kind: 'monitor.low_gas.paused',
      severity: 'critical',
      immediate: true,
      dedupeKey: 'monitor.low_gas',
    })
    expect(rec.events[0]!.message).toContain('0.05 SOL < MIN_GAS_SOL 0.1 SOL')
    expect(ctl.changes).toBe(1)

    chain.setSol(PRIZE, 105_000_000n) // 0.105 — above the threshold but inside the 10% band
    expect((await monitor.check()).lowGas).toBe(true)
    expect(rec.events).toHaveLength(1)

    chain.setSol(PRIZE, 110_000_000n) // 0.11 = threshold × 1.1
    expect((await monitor.check()).lowGas).toBe(false)
    expect(rec.events).toHaveLength(2)
    expect(rec.events[1]).toMatchObject({
      kind: 'monitor.low_gas.resumed',
      severity: 'info',
      immediate: true,
      dedupeKey: 'monitor.low_gas',
    })
    expect(ctl.changes).toBe(2)
  })

  it('reports a low-gas boot as paused without hysteresis on the first read', async () => {
    const { monitor, rec, chain } = monitorSetup()
    chain.setSol(PRIZE, 105_000_000n) // inside the band — fine at boot (never was below)
    expect((await monitor.check()).lowGas).toBe(false)
    const b = monitorSetup()
    b.chain.setSol(PRIZE, 1_000n)
    expect((await b.monitor.check()).lowGas).toBe(true)
    expect(b.rec.kinds()).toEqual(['monitor.low_gas.paused'])
    expect(rec.events).toHaveLength(0)
  })

  it('pauses when P = PUMP − J − outstanding drops below the USD reserve (finalized balance, mocked price)', async () => {
    const { monitor, rec, chain, ctl } = monitorSetup()
    ctl.reserved = { jackpotRaw: 30_000n * PUMP, outstandingRaw: 15_000n * PUMP } // P = 55k < 60k
    let s = await monitor.check()
    expect(s).toMatchObject({ lowPool: true, lowPoolReason: 'below_reserve', poolRaw: 55_000n * PUMP })
    expect(rec.kinds()).toEqual(['monitor.low_pool.paused'])
    expect(rec.events[0]).toMatchObject({
      severity: 'critical',
      immediate: true,
      dedupeKey: 'monitor.low_pool',
    })
    expect(rec.events[0]!.message).toContain('55,000 PUMP < reserve 60,000 PUMP')

    // an unfinalized deposit doesn't count yet
    chain.credit(PRIZE, MINT, 20_000n * PUMP)
    s = await monitor.check()
    expect(s.prizePumpRaw).toBe(100_000n * PUMP)
    expect(s.lowPool).toBe(true)

    chain.advance(3) // finalized: P = 75k ≥ 66k (reserve × 1.1)
    s = await monitor.check()
    expect(s).toMatchObject({ lowPool: false, lowPoolReason: null, poolRaw: 75_000n * PUMP })
    expect(rec.kinds()).toEqual(['monitor.low_pool.paused', 'monitor.low_pool.resumed'])

    // PUMP price halves → reserve doubles to 120k PUMP → paused again
    ctl.price = PRICE_E18 / 2n
    s = await monitor.check()
    expect(s).toMatchObject({ lowPool: true, reserveRaw: 120_000n * PUMP })
    // price recovers: reserve back to 60k, P = 75k clears the 66k resume level
    ctl.price = PRICE_E18
    s = await monitor.check()
    expect(s.lowPool).toBe(false)
    expect(rec.kinds()).toEqual([
      'monitor.low_pool.paused',
      'monitor.low_pool.resumed',
      'monitor.low_pool.paused',
      'monitor.low_pool.resumed',
    ])
  })

  it('applies hysteresis to the pool reserve', async () => {
    const { monitor, chain, ctl } = monitorSetup()
    ctl.reserved = { jackpotRaw: 45_000n * PUMP, outstandingRaw: 0n } // P = 55k
    expect((await monitor.check()).lowPool).toBe(true)
    chain.credit(PRIZE, MINT, 5_000n * PUMP) // P = 60k = reserve, but < 66k
    chain.advance(3)
    expect((await monitor.check()).lowPool).toBe(true)
    chain.credit(PRIZE, MINT, 6_000n * PUMP) // P = 66k
    chain.advance(3)
    expect((await monitor.check()).lowPool).toBe(false)
  })

  it('fails closed when no price has ever been known, and resumes once one is', async () => {
    const { monitor, rec, ctl } = monitorSetup({ price: null })
    let s = await monitor.check()
    expect(s).toMatchObject({ lowPool: true, lowPoolReason: 'no_price', reserveRaw: null, lowGas: false })
    expect(rec.events).toHaveLength(1)
    expect(rec.events[0]).toMatchObject({ kind: 'monitor.no_price', severity: 'critical', immediate: true })
    expect(rec.events[0]!.message).toContain('no price known')

    s = await monitor.check() // still no price: no repeat alert
    expect(rec.events).toHaveLength(1)

    ctl.price = PRICE_E18 // P = 100k vs 60k: the plain threshold applies (it was never below the reserve)
    s = await monitor.check()
    expect(s).toMatchObject({ lowPool: false, reserveRaw: 60_000n * PUMP })
    expect(rec.kinds()).toEqual(['monitor.no_price', 'monitor.low_pool.resumed'])

    ctl.price = null // oracle lost its price again: keep the last computed reserve
    s = await monitor.check()
    expect(s).toMatchObject({ lowPool: false, reserveRaw: 60_000n * PUMP })
  })

  it('alerts on low CREATOR gas without pausing payouts', async () => {
    const { monitor, rec, chain } = monitorSetup()
    chain.setSol(CREATOR, SOL / 100n) // 0.01 < 0.05
    let s = await monitor.check()
    expect(s).toMatchObject({
      creatorGasLow: true,
      lowGas: false,
      lowPool: false,
      creatorSolLamports: SOL / 100n,
    })
    expect(rec.events).toHaveLength(1)
    expect(rec.events[0]).toMatchObject({
      kind: 'monitor.creator_gas_low',
      severity: 'warn',
      immediate: true,
      dedupeKey: 'monitor.creator_gas',
    })
    chain.setSol(CREATOR, 60_000_000n) // 0.06 ≥ 0.055
    s = await monitor.check()
    expect(s.creatorGasLow).toBe(false)
    expect(rec.kinds()).toEqual(['monitor.creator_gas_low', 'monitor.creator_gas_ok'])
  })

  it('works without a CREATOR wallet', async () => {
    const { monitor, rec } = monitorSetup({ creator: null })
    const s = await monitor.check()
    expect(s).toMatchObject({ creatorSolLamports: null, creatorGasLow: false, lowGas: false, lowPool: false })
    expect(rec.events).toHaveLength(0)
  })

  it('keeps the last state and alerts when the RPC is down (never throws)', async () => {
    const { monitor, rec, chain } = monitorSetup()
    chain.faults.rpcDown = true
    let s = await monitor.check()
    expect(s).toMatchObject({ lowGas: true, lowPool: true, checkedAt: null }) // still fail-closed
    expect(s.lastError).toContain('RPC unavailable')
    expect(rec.events[0]).toMatchObject({ kind: 'monitor.check_failed', dedupeKey: 'monitor.check_failed' })

    chain.faults.rpcDown = false
    s = await monitor.check()
    expect(s).toMatchObject({ lowGas: false, lowPool: false, lastError: null })
    const checkedAt = s.checkedAt

    chain.faults.rpcDown = true
    s = await monitor.check()
    expect(s).toMatchObject({ lowGas: false, lowPool: false, checkedAt })
    expect(rec.kinds()).toEqual(['monitor.check_failed', 'monitor.check_failed'])
  })

  it('requestCheck() runs an out-of-band check and coalesces concurrent requests', async () => {
    const { monitor, rec, chain, ctl } = monitorSetup()
    await monitor.check()
    chain.setSol(PRIZE, 1_000n)
    monitor.requestCheck('payout #9: insufficient SOL')
    await vi.waitFor(() => expect(monitor.state().lowGas).toBe(true))
    expect(rec.events[0]!.data).toMatchObject({ trigger: 'payout #9: insufficient SOL' })
    await monitor.check() // settle

    const before = ctl.reservedCalls
    const p1 = monitor.check()
    const p2 = monitor.check() // queued behind the in-flight one → exactly one more read
    monitor.requestCheck()
    expect(p2).toBe(p1)
    await p1
    expect(ctl.reservedCalls - before).toBe(2)
  })

  it('start()/stop() run the check loop on the interval', async () => {
    vi.useFakeTimers()
    try {
      const { monitor, ctl } = monitorSetup()
      monitor.start()
      monitor.start() // idempotent
      await vi.advanceTimersByTimeAsync(0)
      expect(ctl.reservedCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(29_999)
      expect(ctl.reservedCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(ctl.reservedCalls).toBe(2)
      await monitor.stop()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(ctl.reservedCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('posts pause alerts to Telegram immediately through the real alerter', async () => {
    const tg = fakeTelegram()
    const sink = new MemoryEventsSink()
    const a = new TelegramAlerter({
      botToken: TOKEN,
      chatId: CHAT,
      digestSeconds: 5,
      sink,
      fetchImpl: tg.fetchImpl,
      logger: recordingLogger().logger,
    })
    const { monitor, chain } = monitorSetup({ alerter: a })
    chain.setSol(PRIZE, 1_000n)
    await monitor.check()
    await a.close()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.body.text).toContain('🚨 <b>CRITICAL</b> · monitor.low_gas.paused')
    expect(tg.sent[0]!.body.text).toContain(PRIZE)
    expect(sink.events[0]!.data).toMatchObject({ prizeSolLamports: '1000', minGasLamports: '100000000' })
  })
})
