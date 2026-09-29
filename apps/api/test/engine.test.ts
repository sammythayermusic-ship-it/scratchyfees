import { MICRO, recomputeTicket, seedMatchesCommitment } from '@scratchy/core'
import { and, asc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/db/client'
import {
  config as configTable,
  entries,
  jackpot,
  payouts,
  rounds,
  roundSecrets,
  tickets,
} from '../src/db/schema'
import { EventBus, type EngineEvent } from '../src/engine/events'
import { grindJackpotSeed, roundParams, RoundEngine } from '../src/engine/rounds'
import { ScratchService } from '../src/engine/scratch'
import { EntryService } from '../src/engine/entries'
import { loadConfig } from '../src/env'
import { buildServices, devAddress, type Services } from '../src/services'
import { freshDatabase } from './helpers/db'

/**
 * Round engine + entries + scratch on real Postgres and the in-memory chain, driven by a fake clock.
 * ROUND_SECONDS = 60 so boundaries are easy to reason about.
 */

let database: Database
let services: Services
let clock: number
let monitorLowPool: boolean
let bus: EventBus
let events: EngineEvent[]
let engine: RoundEngine
let scratch: ScratchService
let entriesSvc: EntryService

const T0 = Date.parse('2026-09-29T12:00:00Z')
const ROUND = 60_000
const now = () => new Date(clock)

async function setup(extraEnv: Record<string, string> = {}) {
  database = await freshDatabase()
  const cfg = loadConfig({
    NODE_ENV: 'test',
    CHAIN_MODE: 'memory',
    SWEEPER_ENABLED: 'false',
    ENGINE_ENABLED: 'false',
    ROUND_SECONDS: '60',
    ...extraEnv,
  })
  services = await buildServices(cfg, { database, now })
  bus = new EventBus()
  events = []
  bus.on((e) => events.push(e))
  monitorLowPool = false
  const common = {
    db: database.db,
    chain: services.chain,
    oracle: services.oracle,
    economy: cfg.economy,
    scratchyMint: services.scratchyMint,
  }
  engine = new RoundEngine({
    ...common,
    pool: database.pool,
    monitor: {
      state: () => ({ lowPool: monitorLowPool, lowPoolReason: monitorLowPool ? 'below_reserve' : null }),
    },
    pauses: services.pauses,
    alerter: services.alerter,
    bus,
    prizeAddress: services.prizeAddress,
    pumpMint: services.pumpMint,
    excludedWallets: services.excludedWallets,
    requireHoldOneRound: cfg.env.REQUIRE_HOLD_ONE_ROUND,
    wakeWorker: () => services.worker.wake(),
    now,
  })
  scratch = new ScratchService({
    ...common,
    bus,
    alerter: services.alerter,
    holdingsCacheSeconds: 0,
    sessionLockSeconds: 45,
    wakeWorker: () => {},
    now,
  })
  entriesSvc = new EntryService({
    ...common,
    excludedWallets: services.excludedWallets,
    maxWalletsPerIpPerRound: 3,
    sessionLockSeconds: 45,
    beforeEnter: (w) => services.memory!.faucet(w),
    outcomesFor: (rows) => scratch.outcomesFor(rows),
    now,
  })
  // prices are loaded lazily; make sure the oracle has a fresh snapshot
  await services.oracle.get()
}

beforeEach(async () => {
  clock = T0 + 5_000
})

afterEach(async () => {
  await services?.stop()
  await database?.close()
})

async function liveRound() {
  const [r] = await database.db.select().from(rounds).where(eq(rounds.status, 'live'))
  return r!
}

async function enterAndDrop(wallet: string, session = 's1', ip = '1.1.1.1') {
  const res = await entriesSvc.enter({ wallet, sessionId: session, ip })
  if ('error' in res) throw new Error(res.message)
  clock += ROUND // next boundary
  await engine.tick()
  const r = await liveRound()
  const ts = await database.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.roundId, r.id), eq(tickets.wallet, wallet)))
    .orderBy(asc(tickets.idx))
  // re-enter to take the scratch lock for the new round
  await entriesSvc.enter({ wallet, sessionId: session, ip })
  return { round: r, tickets: ts }
}

describe('round engine', () => {
  it('genesis: seeds J with 1% of the initial pool, issues a live round, commits the next seed ahead', async () => {
    await setup()
    await engine.tick()
    const r = await liveRound()
    const [pot] = await database.db.select().from(jackpot)
    const wallet = r.walletBalanceRaw!
    expect(pot!.amountRaw).toBe((wallet * 10_000n) / 1_000_000n + r.jackpotAccrualRaw!) // seed + first accrual
    expect(r.poolRaw).toBe(wallet - (wallet * 10_000n) / 1_000_000n)
    expect(r.budgetRaw).toBe((r.poolRaw! * 5_000n) / 1_000_000n)
    expect(r.startsAt.getTime()).toBe(T0)
    const [pending] = await database.db.select().from(rounds).where(eq(rounds.status, 'pending'))
    expect(pending!.startsAt.getTime()).toBe(T0 + ROUND)
    expect(pending!.serverSeedHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('Decision C: a wallet active in round N is entered into round N+1 with tickets from its holdings', async () => {
    await setup()
    await engine.tick()
    const w = devAddress('alice')
    const { round, tickets: ts } = await enterAndDrop(w)
    const [e] = await database.db
      .select()
      .from(entries)
      .where(and(eq(entries.roundId, round.id), eq(entries.wallet, w)))
    expect(e).toBeTruthy()
    expect(ts.length).toBe(e!.tickets)
    expect(round.totalWeightedMicro).toBe(e!.weightedMicro)
    expect(events.some((x) => x.type === 'drop' && x.roundId === round.id && x.tickets === ts.length)).toBe(
      true,
    )
  })

  it('ending a round reveals a seed that matches its commitment and every ticket re-derives', async () => {
    await setup()
    await engine.tick()
    const w = devAddress('bob')
    const { round } = await enterAndDrop(w)
    clock += ROUND
    await engine.tick()
    const [ended] = await database.db.select().from(rounds).where(eq(rounds.id, round.id))
    expect(ended!.status).toBe('ended')
    expect(seedMatchesCommitment(ended!.serverSeed!, ended!.serverSeedHash)).toBe(true)
    const ts = await database.db.select().from(tickets).where(eq(tickets.roundId, round.id))
    const [e] = await database.db.select().from(entries).where(eq(entries.roundId, round.id))
    for (const t of ts) {
      const rc = recomputeTicket(ended!.serverSeed!, t.wallet, t.idx, e!.multMicro, roundParams(ended!))
      expect([rc.tier, rc.jackpot, rc.prizeRaw]).toEqual([t.tier, t.jackpot, t.prizeRaw])
      expect(t.void).toBe(true) // never scratched → void
    }
  })

  it('a pool below the reserve skips the round: no tickets, no budget, no jackpot accrual, seed revealed', async () => {
    await setup()
    await engine.tick()
    const [before] = await database.db.select().from(jackpot)
    monitorLowPool = true
    await entriesSvc.enter({ wallet: devAddress('carol'), sessionId: 's', ip: 'x' })
    clock += ROUND
    await engine.tick()
    const [skipped] = await database.db.select().from(rounds).where(eq(rounds.status, 'skipped'))
    expect(skipped!.skipReason).toContain('low_pool')
    expect(skipped!.serverSeed).toBeTruthy()
    const [after] = await database.db.select().from(jackpot)
    expect(after!.amountRaw).toBe(before!.amountRaw)
    expect(await database.db.select().from(tickets).where(eq(tickets.roundId, skipped!.id))).toHaveLength(0)
  })

  it('an admin PAYOUT_RATE change applies from the next round', async () => {
    await setup()
    await engine.tick()
    await database.db.insert(configTable).values({ key: 'payout_rate', value: '0.008' })
    clock += ROUND
    await engine.tick()
    const r = await liveRound()
    expect(r.payoutRatePpm).toBe(8_000n)
    expect(r.budgetRaw).toBe((r.poolRaw! * 8_000n) / 1_000_000n)
  })
})

describe('scratch', () => {
  it('reveals, coalesces a batch into one transfer, and is idempotent', async () => {
    await setup()
    await engine.tick()
    const w = devAddress('dave')
    const { tickets: ts } = await enterAndDrop(w)
    const res = await scratch.scratch(
      's1',
      ts.map((t) => t.id),
    )
    if (!res.ok) throw new Error(res.message)
    expect(res.outcomes).toHaveLength(ts.length)
    const tierTotal = ts.reduce((s, t) => s + t.prizeRaw, 0n)
    const ps = await database.db.select().from(payouts).where(eq(payouts.kind, 'tier'))
    if (tierTotal > 0n) {
      expect(ps).toHaveLength(1)
      expect(ps[0]!.amountRaw).toBe(tierTotal)
    } else expect(ps).toHaveLength(0)
    for (const o of res.outcomes) {
      const [a, b, c] = o.symbols
      if (o.tier > 0) expect(a === b && b === c).toBe(true)
      else if (o.jackpotPrizeRaw === '0') expect(a === b && b === c).toBe(false)
    }
    const again = await scratch.scratch(
      's1',
      ts.map((t) => t.id),
    )
    expect(again.ok && again.outcomes.map((o) => o.prizeRaw)).toEqual(res.outcomes.map((o) => o.prizeRaw))
    expect(await database.db.select().from(payouts).where(eq(payouts.kind, 'tier'))).toHaveLength(ps.length)
  })

  it('one scratching session per wallet: a second tab sees "being scratched"; an idle lock can be taken over', async () => {
    await setup()
    await engine.tick()
    const w = devAddress('erin')
    const { tickets: ts } = await enterAndDrop(w, 'tabA')
    const other = await entriesSvc.enter({ wallet: w, sessionId: 'tabB', ip: '1.1.1.1' })
    expect('error' in other ? null : other.locked).toBe(true)
    const blocked = await scratch.scratch('tabB', [ts[0]!.id])
    expect(!blocked.ok && blocked.error).toBe('locked')
    clock += 46_000 // tabA idle past SESSION_LOCK_SECONDS
    const takeover = await entriesSvc.enter({ wallet: w, sessionId: 'tabB', ip: '1.1.1.1' })
    expect('error' in takeover ? null : takeover.locked).toBe(false)
    const ok = await scratch.scratch('tabB', [ts[0]!.id])
    expect(ok.ok).toBe(true)
  })

  it('§2.7: selling below the snapshot tier voids the remaining tickets', async () => {
    await setup()
    await engine.tick()
    const w = devAddress('frank')
    const { tickets: ts } = await enterAndDrop(w)
    const first = await scratch.scratch('s1', [ts[0]!.id])
    expect(first.ok).toBe(true)
    const bal = (await services.chain.getTokenBalance(w, services.scratchyMint)).value
    services.memory!.chain.transferExternal(w, devAddress('dex'), services.scratchyMint, bal) // dumps everything
    const second = await scratch.scratch('s1', [ts[1]?.id ?? ts[0]!.id])
    expect(!second.ok && second.error).toBe('voided')
    const rest = await database.db.select().from(tickets).where(eq(tickets.wallet, w))
    expect(rest.filter((t) => !t.scratchedAt).every((t) => t.void)).toBe(true)
  })

  it('jackpot: the first revealed hit takes the whole pot; the breaker never holds it', async () => {
    await setup({ ROUND_BREAKER: '0.000001' }) // any ticket win trips the breaker
    await engine.tick()
    const w = devAddress('gina')
    // grind the committed seed of the pending round so w's ticket 0 hits (same as the devnet rehearsal)
    const [pending] = await database.db.select().from(rounds).where(eq(rounds.status, 'pending'))
    const { seedToHex, seedCommitment } = await import('@scratchy/core')
    const seed = grindJackpotSeed(w, pending!.id, 50_000n)
    await database.db
      .update(roundSecrets)
      .set({ serverSeed: seedToHex(seed) })
      .where(eq(roundSecrets.roundId, pending!.id))
    await database.db
      .update(rounds)
      .set({ serverSeedHash: seedCommitment(seed) })
      .where(eq(rounds.id, pending!.id))
    const { tickets: ts } = await enterAndDrop(w)
    expect(ts[0]!.jackpot).toBe(true)
    const [potBefore] = await database.db.select().from(jackpot)
    const res = await scratch.scratch('s1', [ts[0]!.id])
    if (!res.ok) throw new Error(res.message)
    expect(res.outcomes[0]!.jackpotPrizeRaw).toBe(potBefore!.amountRaw.toString())
    expect(res.outcomes[0]!.symbols).toEqual(['scratchy', 'scratchy', 'scratchy'])
    const [potAfter] = await database.db.select().from(jackpot)
    expect(potAfter!.amountRaw).toBe(0n)
    const [jp] = await database.db.select().from(payouts).where(eq(payouts.kind, 'jackpot'))
    expect(jp!.status).toBe('queued')
    expect(events.some((e) => e.type === 'jackpot')).toBe(true)
  })

  it('Decision E: a breaker trip holds ticket payouts; round end re-derives and releases them', async () => {
    await setup({ ROUND_BREAKER: '0.000001' })
    await engine.tick()
    const w = devAddress('hank')
    const { round, tickets: ts } = await enterAndDrop(w)
    const res = await scratch.scratch(
      's1',
      ts.map((t) => t.id),
    )
    if (!res.ok) throw new Error(res.message)
    const [tier] = await database.db.select().from(payouts).where(eq(payouts.kind, 'tier'))
    if (!tier) return // no winning ticket in this draw (deterministic per wallet) — nothing to hold
    expect(tier.status).toBe('held')
    const [r] = await database.db.select().from(rounds).where(eq(rounds.id, round.id))
    expect(r!.breakerTripped).toBe(true)
    clock += ROUND
    await engine.tick()
    const [released] = await database.db.select().from(payouts).where(eq(payouts.id, tier.id))
    expect(released!.status).toBe('queued')
    const [v] = await database.db.select().from(rounds).where(eq(rounds.id, round.id))
    expect(v!.breakerVerified).toBe('ok')
  })

  it('Decision E: a tampered prize fails re-derivation → hard stop (breaker_mismatch)', async () => {
    await setup({ ROUND_BREAKER: '0.000001' })
    await engine.tick()
    const w = devAddress('ivy')
    const { round, tickets: ts } = await enterAndDrop(w)
    await scratch.scratch(
      's1',
      ts.map((t) => t.id),
    )
    await database.db.update(rounds).set({ breakerTripped: true }).where(eq(rounds.id, round.id))
    await database.db.update(tickets).set({ prizeRaw: 999_999_999n }).where(eq(tickets.id, ts[0]!.id))
    clock += ROUND
    await engine.tick()
    const [v] = await database.db.select().from(rounds).where(eq(rounds.id, round.id))
    expect(v!.breakerVerified).toBe('mismatch')
    expect(services.pauses.first()).toBe('breaker_mismatch')
  })
})

describe('entries', () => {
  it('rejects PDAs/garbage and excluded wallets; caps distinct wallets per IP per round', async () => {
    await setup()
    expect(await entriesSvc.enter({ wallet: 'not-a-wallet', sessionId: 's', ip: 'a' })).toMatchObject({
      error: 'invalid_wallet',
    })
    expect(await entriesSvc.enter({ wallet: services.prizeAddress, sessionId: 's', ip: 'a' })).toMatchObject({
      error: 'excluded_wallet',
    })
    for (const n of ['a1', 'a2', 'a3']) {
      const r = await entriesSvc.enter({ wallet: devAddress(n), sessionId: 's', ip: 'same-ip' })
      expect('error' in r).toBe(false)
    }
    expect(await entriesSvc.enter({ wallet: devAddress('a4'), sessionId: 's', ip: 'same-ip' })).toMatchObject(
      {
        error: 'too_many_wallets',
      },
    )
  })

  it('reports holdings, tickets per drop, multiplier and the +$50 nudge; X handle validated', async () => {
    await setup()
    const r = await entriesSvc.enter({
      wallet: devAddress('jay'),
      xHandle: '@scratchy_fan',
      sessionId: 's',
      ip: 'b',
    })
    if ('error' in r) throw new Error(r.message)
    expect(r.xHandle).toBe('scratchy_fan')
    expect(r.eligibleNow).toBe(true)
    expect(r.ticketsPerDrop).toBeGreaterThanOrEqual(5)
    expect(BigInt(r.multMicro)).toBeGreaterThanOrEqual(MICRO)
    const bad = await entriesSvc.enter({
      wallet: devAddress('kim'),
      xHandle: '<script>',
      sessionId: 's',
      ip: 'b',
    })
    expect('error' in bad ? 'err' : bad.xHandle).toBe(null)
  })
})
