import {
  deriveTicket,
  generateServerSeed,
  MICRO,
  recomputeTicket,
  seedCommitment,
  seedMatchesCommitment,
  seedToHex,
} from '@scratchy/core'
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
let engineDeps: ConstructorParameters<typeof RoundEngine>[0]
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
  engineDeps = {
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
  }
  engine = new RoundEngine(engineDeps)
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

/** replace the pending round's committed seed with one satisfying `pred` (test-only; like the rehearsal's grinder) */
async function forceSeed(pred: (seed: Uint8Array, roundId: number) => boolean) {
  const [pending] = await database.db.select().from(rounds).where(eq(rounds.status, 'pending'))
  for (let i = 0; i < 200_000; i++) {
    const seed = generateServerSeed()
    if (!pred(seed, pending!.id)) continue
    await database.db
      .update(roundSecrets)
      .set({ serverSeed: seedToHex(seed) })
      .where(eq(roundSecrets.roundId, pending!.id))
    await database.db
      .update(rounds)
      .set({ serverSeedHash: seedCommitment(seed) })
      .where(eq(rounds.id, pending!.id))
    return
  }
  throw new Error('could not grind a seed')
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

  it('Decision C: activity that continues past the boundary (re-paste / heartbeat at the drop) never drops the wallet', async () => {
    await setup()
    await engine.tick()
    const w = devAddress('bea')
    await entriesSvc.enter({ wallet: w, sessionId: 's1', ip: '1.1.1.1' }) // active in round N
    clock += ROUND - 5_000 + 100 // 100 ms past the boundary, BEFORE the engine ticks
    await entriesSvc.enter({ wallet: w, sessionId: 's1', ip: '1.1.1.1' }) // the client refreshes at the drop
    await entriesSvc.heartbeat('s1', w)
    await engine.tick()
    const r = await liveRound()
    const [e] = await database.db
      .select()
      .from(entries)
      .where(and(eq(entries.roundId, r.id), eq(entries.wallet, w)))
    expect(e).toBeTruthy()
    // …and a wallet whose FIRST activity is after the boundary waits for the following drop
    const late = devAddress('cal')
    await entriesSvc.enter({ wallet: late, sessionId: 's2', ip: '2.2.2.2' })
    const [none] = await database.db
      .select()
      .from(entries)
      .where(and(eq(entries.roundId, r.id), eq(entries.wallet, late)))
    expect(none).toBeUndefined()
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
    // advisory: tabB sees the hint but is never blocked from scratching (see security #3)
    clock += 46_000 // tabA idle past SESSION_LOCK_SECONDS
    const takeover = await entriesSvc.enter({ wallet: w, sessionId: 'tabB', ip: '1.1.1.1' })
    expect('error' in takeover ? null : takeover.locked).toBe(false)
    const ok = await scratch.scratch('tabB', [ts[0]!.id])
    expect(ok.ok).toBe(true)
  })

  it('the session lock is advisory: a griefer who pastes your wallet first can never lock you out (security #3)', async () => {
    await setup()
    await engine.tick()
    const w = devAddress('olga')
    const { tickets: ts } = await enterAndDrop(w, 'griefer') // the griefer pasted the wallet first and holds the hint
    const owner = await entriesSvc.enter({ wallet: w, sessionId: 'owner', ip: '9.9.9.9' })
    expect('error' in owner ? null : owner.locked).toBe(true) // UI hint: "this wallet's tickets are being scratched"
    const res = await scratch.scratch('owner', [ts[0]!.id, ts[1]?.id ?? ts[0]!.id])
    expect(res.ok).toBe(true) // …but the owner can always scratch their own tickets
    const again = await scratch.scratch('griefer', [ts[0]!.id]) // a replay reveals the same stored outcome, pays nothing twice
    expect(again.ok && res.ok && again.outcomes[0]!.prizeRaw).toBe(res.ok && res.outcomes[0]!.prizeRaw)
    const tier = await database.db.select().from(payouts).where(eq(payouts.kind, 'tier'))
    expect(tier.every((p) => p.wallet === w)).toBe(true) // prizes only ever go to the ticket's wallet
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
    await forceSeed((seed, rid) => {
      const t = deriveTicket(seed, w, rid, 0, 50_000n)
      return t.tier > 0 && !t.jackpot
    })
    const { round, tickets: ts } = await enterAndDrop(w)
    const res = await scratch.scratch(
      's1',
      ts.map((t) => t.id),
    )
    if (!res.ok) throw new Error(res.message)
    const [tier] = await database.db.select().from(payouts).where(eq(payouts.kind, 'tier'))
    expect(tier!.status).toBe('held')
    const [r] = await database.db.select().from(rounds).where(eq(rounds.id, round.id))
    expect(r!.breakerTripped).toBe(true)
    clock += ROUND
    await engine.tick()
    const [released] = await database.db.select().from(payouts).where(eq(payouts.id, tier!.id))
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

describe('concurrency (Phase 3 gate: double-scratch, jackpot race, engine handover)', () => {
  it('double-scratch: two concurrent requests for the same tickets reveal once and pay once', async () => {
    await setup()
    await engine.tick()
    const w = devAddress('kara')
    await forceSeed((seed, rid) => {
      const t = deriveTicket(seed, w, rid, 0, 50_000n)
      return t.tier > 0 && !t.jackpot
    })
    const { tickets: ts } = await enterAndDrop(w)
    expect(ts[0]!.tier).toBeGreaterThan(0)
    const ids = ts.map((t) => t.id)
    const [a, b] = await Promise.all([scratch.scratch('s1', ids), scratch.scratch('s1', ids)])
    if (!a.ok || !b.ok) throw new Error('scratch failed')
    expect(a.outcomes.map((o) => o.prizeRaw)).toEqual(b.outcomes.map((o) => o.prizeRaw))
    const total = ts.reduce((sum, t) => sum + t.prizeRaw, 0n)
    const paid = (await database.db.select().from(payouts).where(eq(payouts.kind, 'tier'))).reduce(
      (sum, p) => sum + p.amountRaw,
      0n,
    )
    expect(paid).toBe(total)
    const [r] = await database.db.select().from(rounds).where(eq(rounds.id, ts[0]!.roundId))
    expect(r!.realizedRaw).toBe(total)
  })

  it('jackpot race: two wallets hitting in the same round — the pot is paid exactly once', async () => {
    await setup({ JACKPOT_ODDS: '2' })
    await engine.tick()
    const w1 = devAddress('lara')
    const w2 = devAddress('mona')
    await forceSeed(
      (seed, rid) => deriveTicket(seed, w1, rid, 0, 2n).jackpot && deriveTicket(seed, w2, rid, 0, 2n).jackpot,
    )
    await entriesSvc.enter({ wallet: w1, sessionId: 'a', ip: '1.1.1.1' })
    await entriesSvc.enter({ wallet: w2, sessionId: 'b', ip: '2.2.2.2' })
    clock += ROUND
    await engine.tick()
    await entriesSvc.enter({ wallet: w1, sessionId: 'a', ip: '1.1.1.1' })
    await entriesSvc.enter({ wallet: w2, sessionId: 'b', ip: '2.2.2.2' })
    const r = await liveRound()
    const first = async (w: string) =>
      (
        await database.db
          .select()
          .from(tickets)
          .where(and(eq(tickets.roundId, r.id), eq(tickets.wallet, w), eq(tickets.idx, 0)))
      )[0]!
    const [t1, t2] = [await first(w1), await first(w2)]
    expect(t1.jackpot && t2.jackpot).toBe(true)
    const [pot] = await database.db.select().from(jackpot)
    expect(pot!.amountRaw).toBeGreaterThan(0n)
    const [x, y] = await Promise.all([scratch.scratch('a', [t1.id]), scratch.scratch('b', [t2.id])])
    if (!x.ok || !y.ok) throw new Error('scratch failed')
    const got = [x, y].map((res) => BigInt(res.outcomes[0]!.jackpotPrizeRaw))
    expect(got.filter((g) => g === pot!.amountRaw)).toHaveLength(1)
    expect(got[0]! + got[1]!).toBe(pot!.amountRaw)
    const jps = await database.db.select().from(payouts).where(eq(payouts.kind, 'jackpot'))
    expect(jps.reduce((sum, p) => sum + p.amountRaw, 0n)).toBe(pot!.amountRaw)
    const [after] = await database.db.select().from(jackpot)
    expect(after!.amountRaw).toBe(0n)
  })

  it('two engine instances racing one boundary start exactly one round (no double jackpot accrual)', async () => {
    await setup()
    await engine.tick()
    const other = new RoundEngine(engineDeps)
    clock += ROUND
    const [potBefore] = await database.db.select().from(jackpot)
    await Promise.all([engine.tick(), other.tick()])
    await Promise.all([engine.tick(), other.tick()])
    const all = await database.db.select().from(rounds).orderBy(asc(rounds.id))
    const live = all.filter((x) => x.status === 'live')
    expect(live).toHaveLength(1)
    expect(all.filter((x) => x.status === 'pending')).toHaveLength(1)
    expect(all.filter((x) => x.status === 'ended')).toHaveLength(1)
    expect(new Set(all.map((x) => x.startsAt.getTime())).size).toBe(all.length)
    const [potAfter] = await database.db.select().from(jackpot)
    expect(potAfter!.amountRaw - potBefore!.amountRaw).toBe(live[0]!.jackpotAccrualRaw)
  })
})
