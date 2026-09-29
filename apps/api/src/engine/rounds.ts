import {
  deriveTicket,
  entryTerms,
  generateServerSeed,
  holdingsUsdMicro,
  jackpotSeedRaw,
  poolSnapshot,
  recomputeTicket,
  roundBudget,
  seedCommitment,
  seedFromHex,
  seedMatchesCommitment,
  seedToHex,
  tierPrizeRaw,
  TIERS,
  validatePayoutRatePpm,
  decimalToScaledExact,
  type EconomyConfig,
  type RoundParams,
} from '@scratchy/core'
import { and, asc, desc, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm'
import type pg from 'pg'
import type { Alerter } from '../alerts/types'
import type { ChainClient } from '../chain/types'
import type { Db } from '../db/client'
import { LOCK_KEYS, tryAdvisoryLock, type ReleaseLock } from '../db/lock'
import { reservedRaw } from '../db/queries'
import { config, entries, jackpot, payouts, rounds, roundSecrets, tickets, wallets } from '../db/schema'
import type { PriceOracle } from '../oracle/types'
import type { EventBus } from './events'
import type { PauseRegistry } from './pauses'

/**
 * Round engine (PLAN §2.2, §2.7, §4; Decisions C and E). Single leader via a Postgres advisory lock.
 *
 * Rounds are aligned to the clock (multiples of ROUND_SECONDS since the epoch: :00, :10, …).
 * At each boundary T:
 *   end the live round  → reveal its seed, void unscratched tickets, run the breaker verification (E)
 *   start round at T    → the seed was committed one round earlier (pending row); snapshot P at finalized
 *                         commitment; J seeded with 1% of P at genesis, then J += 0.1·B; entrants = wallets
 *                         active during [T − ROUND_SECONDS, T) (C); holdings × price → tickets/mult/W;
 *                         every ticket pre-rolled with HMAC(seed, wallet:round:idx) and its exact prize stored
 *   commit ahead        → create the next pending round with a fresh seed and publish sha256(seed)
 * Rounds whose pool is below MIN_POOL_RESERVE (or with no price ever known) are SKIPPED: no tickets, no
 * budget, no jackpot accrual. Downtime simply resumes at the current boundary.
 */

type RoundRow = typeof rounds.$inferSelect

export interface RoundEngineDeps {
  db: Db
  pool: pg.Pool
  chain: ChainClient
  oracle: PriceOracle
  monitor: { state(): { lowPool: boolean; lowPoolReason: string | null } }
  pauses: PauseRegistry
  alerter: Alerter
  bus: EventBus
  economy: EconomyConfig
  prizeAddress: string
  pumpMint: string
  scratchyMint: string
  excludedWallets: Set<string>
  requireHoldOneRound: boolean
  wakeWorker: () => void
  /** devnet/localnet rehearsal only: grind the NEXT round's seed (before its commitment) so this wallet's
   *  ticket 0 hits the jackpot — the commitment is published normally, so /fair still verifies */
  devForceJackpotWallet?: string | null
  now?: () => Date
}

export class RoundEngine {
  private readonly now: () => Date
  private release: ReleaseLock | null = null
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private scratchyDecimals: number | null = null

  constructor(private readonly d: RoundEngineDeps) {
    this.now = d.now ?? (() => new Date())
  }

  get roundMs(): number {
    return this.d.economy.roundSeconds * 1000
  }

  /** start of the round containing `at` */
  alignedStart(at: Date): Date {
    return new Date(Math.floor(at.getTime() / this.roundMs) * this.roundMs)
  }

  /** Acquire leadership (retrying) and run the boundary loop. */
  start(): void {
    const loop = async () => {
      if (this.busy) return
      this.busy = true
      try {
        if (!this.release) this.release = await tryAdvisoryLock(this.d.pool, LOCK_KEYS.roundEngine)
        if (this.release) await this.tick()
      } catch (e) {
        this.d.alerter.notify({
          kind: 'engine.error',
          severity: 'critical',
          message: `round engine tick failed: ${(e as Error).message}`,
          immediate: true,
          dedupeKey: 'engine.error',
        })
      } finally {
        this.busy = false
      }
    }
    void loop()
    this.timer = setInterval(() => void loop(), 1_000)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    while (this.busy) await new Promise((r) => setTimeout(r, 50))
    await this.release?.()
    this.release = null
  }

  async liveRound(): Promise<RoundRow | null> {
    const [r] = await this.d.db
      .select()
      .from(rounds)
      .where(eq(rounds.status, 'live'))
      .orderBy(desc(rounds.id))
      .limit(1)
    return r ?? null
  }

  async pendingRound(): Promise<RoundRow | null> {
    const [r] = await this.d.db
      .select()
      .from(rounds)
      .where(eq(rounds.status, 'pending'))
      .orderBy(asc(rounds.id))
      .limit(1)
    return r ?? null
  }

  /** Idempotent: end what is due, start the round for the current boundary. Exposed for tests. */
  async tick(): Promise<void> {
    const now = this.now()
    const T = this.alignedStart(now)
    const live = await this.liveRound()
    if (live && live.endsAt.getTime() <= now.getTime()) await this.endRound(live)
    const current = live && live.endsAt.getTime() > now.getTime() ? live : null
    if (!current) {
      const [already] = await this.d.db.select().from(rounds).where(eq(rounds.startsAt, T)).limit(1)
      if (!already || already.status === 'pending') await this.startRound(T)
    }
    if (!(await this.pendingRound())) await this.createPending(new Date(T.getTime() + this.roundMs))
  }

  // ── end ────────────────────────────────────────────────────────────────────
  async endRound(r: RoundRow): Promise<void> {
    const ended = await this.d.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(rounds).where(eq(rounds.id, r.id)).for('update')
      if (!locked || locked.status !== 'live') return null
      const [secret] = await tx.select().from(roundSecrets).where(eq(roundSecrets.roundId, r.id))
      if (!secret) throw new Error(`round ${r.id} has no stored seed`)
      await tx
        .update(tickets)
        .set({ void: true })
        .where(and(eq(tickets.roundId, r.id), isNull(tickets.scratchedAt), eq(tickets.void, false)))
      await tx.update(entries).set({ sessionId: null, lockExpiresAt: null }).where(eq(entries.roundId, r.id))
      const [u] = await tx
        .update(rounds)
        .set({ status: 'ended', serverSeed: secret.serverSeed })
        .where(eq(rounds.id, r.id))
        .returning()
      return u!
    })
    if (!ended) return
    this.d.bus.emit({ type: 'round_end', roundId: ended.id, serverSeed: ended.serverSeed! })
    if (ended.breakerTripped && !ended.breakerVerified) await this.verifyBreakerRound(ended)
  }

  /**
   * Decision E: the breaker tripped in this round. Re-derive every revealed ticket from the now-public seed
   * and the round's stored parameters. All match → release the held payouts (variance, verified).
   * Any mismatch → hard stop (breaker_mismatch) until an admin resumes.
   */
  async verifyBreakerRound(r: RoundRow): Promise<'ok' | 'mismatch'> {
    const params = roundParams(r)
    const revealed = await this.d.db
      .select({ t: tickets, multMicro: entries.multMicro })
      .from(tickets)
      .innerJoin(entries, and(eq(entries.roundId, tickets.roundId), eq(entries.wallet, tickets.wallet)))
      .where(and(eq(tickets.roundId, r.id), isNotNull(tickets.scratchedAt)))
    const mismatches: string[] = []
    if (!r.serverSeed || !seedMatchesCommitment(r.serverSeed, r.serverSeedHash))
      mismatches.push('seed ≠ commitment')
    else {
      for (const { t, multMicro } of revealed) {
        const rc = recomputeTicket(r.serverSeed, t.wallet, t.idx, multMicro, params)
        if (rc.tier !== t.tier || rc.jackpot !== t.jackpot || rc.prizeRaw !== t.prizeRaw) {
          mismatches.push(`ticket ${t.id} (${t.wallet}#${t.idx})`)
        }
      }
    }
    if (mismatches.length === 0) {
      await this.d.db
        .update(payouts)
        .set({ status: 'queued', heldReason: null })
        .where(and(eq(payouts.roundId, r.id), eq(payouts.status, 'held'), eq(payouts.heldReason, 'breaker')))
      await this.d.db.update(rounds).set({ breakerVerified: 'ok' }).where(eq(rounds.id, r.id))
      this.d.alerter.notify({
        kind: 'breaker.verified',
        severity: 'warn',
        message: `round ${r.id}: breaker trip was variance — all ${revealed.length} revealed prizes re-derived from the seed; held payouts released`,
        immediate: true,
      })
      this.d.wakeWorker()
      return 'ok'
    }
    await this.d.db.update(rounds).set({ breakerVerified: 'mismatch' }).where(eq(rounds.id, r.id))
    await this.d.pauses.set(
      'breaker_mismatch',
      `round ${r.id}: ${mismatches.length} prize(s) failed seed recomputation: ${mismatches.slice(0, 5).join(', ')}`,
    )
    return 'mismatch'
  }

  // ── start ──────────────────────────────────────────────────────────────────
  async createPending(startsAt: Date): Promise<RoundRow> {
    let seed = generateServerSeed()
    const forced = this.d.devForceJackpotWallet
    return this.d.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(rounds)
        .values({
          startsAt,
          endsAt: new Date(startsAt.getTime() + this.roundMs),
          status: 'pending',
          serverSeedHash: 'pending',
        })
        .returning()
      if (forced) seed = grindJackpotSeed(forced, row!.id, this.d.economy.jackpotOdds)
      const [u] = await tx
        .update(rounds)
        .set({ serverSeedHash: seedCommitment(seed) })
        .where(eq(rounds.id, row!.id))
        .returning()
      await tx.insert(roundSecrets).values({ roundId: row!.id, serverSeed: seedToHex(seed) })
      return u!
    })
  }

  private async effectiveEconomy(): Promise<EconomyConfig> {
    const [rate] = await this.d.db.select().from(config).where(eq(config.key, 'payout_rate'))
    if (!rate) return this.d.economy
    try {
      return { ...this.d.economy, payoutRatePpm: validatePayoutRatePpm(decimalToScaledExact(rate.value, 6)) }
    } catch {
      return this.d.economy
    }
  }

  async startRound(T: Date): Promise<void> {
    const pending = (await this.pendingRound()) ?? (await this.createPending(T))
    const endsAt = new Date(T.getTime() + this.roundMs)
    const cfg = await this.effectiveEconomy()

    // ── snapshot (outside the transaction: no locks across RPC) ──
    const bal = await this.d.chain.getAtaBalance(this.d.prizeAddress, this.d.pumpMint, 'finalized')
    const outstanding = await this.outstandingAt(bal.slot)
    const [pot] = await this.d.db.select().from(jackpot).where(eq(jackpot.id, 1))
    const genesis = !pot
    let J = pot?.amountRaw ?? 0n
    let P = poolSnapshot({ walletBalanceRaw: bal.value, jackpotRaw: J, outstandingRaw: outstanding })
    if (genesis) {
      J = jackpotSeedRaw(P) // §2.4: seed J with 1% of the initial pool
      P = poolSnapshot({ walletBalanceRaw: bal.value, jackpotRaw: J, outstandingRaw: outstanding })
    }
    const prices = await this.d.oracle.get()
    const monitor = this.d.monitor.state()
    const skipReason = monitor.lowPool
      ? `low_pool${monitor.lowPoolReason ? `:${monitor.lowPoolReason}` : ''}`
      : !prices.scratchyUsd || prices.state === 'none'
        ? 'no_price'
        : null

    const base = {
      startsAt: T,
      endsAt,
      walletBalanceRaw: bal.value,
      outstandingRaw: outstanding,
      snapshotSlot: BigInt(bal.slot),
      poolRaw: P,
      pumpUsdE18: prices.pumpUsd?.valueE18.toString() ?? null,
      scratchyUsdE18: prices.scratchyUsd?.valueE18.toString() ?? null,
      priceState: prices.state,
      payoutRatePpm: cfg.payoutRatePpm,
      jackpotSharePpm: cfg.jackpotSharePpm,
      singlePrizeCapPpm: cfg.singlePrizeCapPpm,
      roundBreakerPpm: cfg.roundBreakerPpm,
      jackpotOdds: cfg.jackpotOdds,
    }

    if (skipReason) {
      await this.d.db.transaction(async (tx) => {
        if (genesis)
          await tx.insert(jackpot).values({ id: 1, amountRaw: J, seeded: true }).onConflictDoNothing()
        const [secret] = await tx.select().from(roundSecrets).where(eq(roundSecrets.roundId, pending.id))
        await tx
          .update(rounds)
          .set({
            ...base,
            status: 'skipped',
            skipReason,
            serverSeed: secret?.serverSeed ?? null, // unused seed: publish it right away
            budgetRaw: 0n,
            ticketBudgetRaw: 0n,
            jackpotAccrualRaw: 0n,
            jackpotAfterRaw: J,
            totalWeightedMicro: 0n,
          })
          .where(eq(rounds.id, pending.id))
      })
      await this.createPending(endsAt)
      this.emitDrop(pending.id, pending.serverSeedHash, T, endsAt, 0, 0, P, J, skipReason)
      this.d.alerter.notify({
        kind: 'round.skipped',
        severity: 'warn',
        message: `round ${pending.id} skipped (${skipReason})`,
        dedupeKey: `round.skipped.${skipReason}`,
      })
      return
    }

    // entrants: active during the previous round window (Decision C)
    const windowStart = new Date(T.getTime() - this.roundMs)
    const conds = [gte(wallets.lastActiveAt, windowStart), lte(wallets.lastActiveAt, T)]
    if (this.d.requireHoldOneRound) conds.push(lte(wallets.eligibleSince, windowStart))
    const candidates = (
      await this.d.db
        .select({ address: wallets.address })
        .from(wallets)
        .where(and(...conds))
    )
      .map((w) => w.address)
      .filter((a) => !this.d.excludedWallets.has(a))
    const holdings = candidates.length
      ? (await this.d.chain.getHoldings(candidates, this.d.scratchyMint)).value
      : new Map<string, bigint>()
    const decimals = await this.scratchyDecimalsOnce()
    const priceE18 = prices.scratchyUsd!.valueE18
    const entrantRows = candidates
      .map((wallet) => {
        const holdingsRaw = holdings.get(wallet) ?? 0n
        const hUsdMicro = holdingsUsdMicro(holdingsRaw, decimals, priceE18)
        return { wallet, holdingsRaw, hUsdMicro, terms: entryTerms(hUsdMicro, cfg) }
      })
      .filter((e) => e.terms.eligible && e.terms.tickets > 0n)
    const W = entrantRows.reduce((s, e) => s + e.terms.weightMicro, 0n)
    const budget = roundBudget(P, cfg)

    const [secret] = await this.d.db.select().from(roundSecrets).where(eq(roundSecrets.roundId, pending.id))
    if (!secret) throw new Error(`pending round ${pending.id} has no seed`)
    const seed = seedFromHex(secret.serverSeed)
    const ticketRows: (typeof tickets.$inferInsert)[] = []
    for (const e of entrantRows) {
      for (let idx = 0; idx < Number(e.terms.tickets); idx++) {
        const dt = deriveTicket(seed, e.wallet, pending.id, idx, cfg.jackpotOdds)
        ticketRows.push({
          roundId: pending.id,
          wallet: e.wallet,
          idx,
          tier: dt.tier,
          jackpot: dt.jackpot,
          prizeRaw: tierPrizeRaw(TIERS[dt.tier]!.k10, budget, e.terms.multMicro, W),
        })
      }
    }

    const Jafter = await this.d.db.transaction(async (tx) => {
      if (genesis)
        await tx.insert(jackpot).values({ id: 1, amountRaw: J, seeded: true }).onConflictDoNothing()
      const [lockedPot] = await tx.select().from(jackpot).where(eq(jackpot.id, 1)).for('update')
      const next = lockedPot!.amountRaw + budget.jackpotAccrualRaw
      await tx.update(jackpot).set({ amountRaw: next, updatedAt: new Date() }).where(eq(jackpot.id, 1))
      await tx
        .update(rounds)
        .set({
          ...base,
          status: 'live',
          budgetRaw: budget.budgetRaw,
          ticketBudgetRaw: budget.ticketBudgetRaw,
          jackpotAccrualRaw: budget.jackpotAccrualRaw,
          jackpotAfterRaw: next,
          singlePrizeCapRaw: budget.singlePrizeCapRaw,
          breakerLimitRaw: budget.breakerLimitRaw,
          totalWeightedMicro: W,
          entrantCount: entrantRows.length,
          ticketCount: ticketRows.length,
        })
        .where(eq(rounds.id, pending.id))
      for (let i = 0; i < entrantRows.length; i += 500) {
        await tx.insert(entries).values(
          entrantRows.slice(i, i + 500).map((e) => ({
            roundId: pending.id,
            wallet: e.wallet,
            holdingsRaw: e.holdingsRaw,
            holdingsUsdMicro: e.hUsdMicro,
            tickets: Number(e.terms.tickets),
            multMicro: e.terms.multMicro,
            weightedMicro: e.terms.weightMicro,
          })),
        )
      }
      for (let i = 0; i < ticketRows.length; i += 1_000) {
        await tx.insert(tickets).values(ticketRows.slice(i, i + 1_000))
      }
      return next
    })
    await this.createPending(endsAt)
    this.emitDrop(
      pending.id,
      pending.serverSeedHash,
      T,
      endsAt,
      entrantRows.length,
      ticketRows.length,
      P,
      Jafter,
      null,
    )
  }

  /** prize payouts owed that had NOT landed by the snapshot slot (confirmed later = still inside the balance) */
  private async outstandingAt(slot: number): Promise<bigint> {
    return (await reservedRaw(this.d.db, slot)).outstandingRaw
  }

  private async scratchyDecimalsOnce(): Promise<number> {
    if (this.scratchyDecimals === null) {
      this.scratchyDecimals = (await this.d.chain.getMintInfo(this.d.scratchyMint)).decimals
    }
    return this.scratchyDecimals
  }

  private emitDrop(
    roundId: number,
    seedHash: string,
    T: Date,
    endsAt: Date,
    entrants: number,
    ticketCount: number,
    P: bigint,
    J: bigint,
    skipped: string | null,
  ): void {
    void this.pendingRound().then((next) =>
      this.d.bus.emit({
        type: 'drop',
        roundId,
        startsAt: T.toISOString(),
        endsAt: endsAt.toISOString(),
        seedHash,
        nextSeedHash: next?.serverSeedHash ?? null,
        entrants,
        tickets: ticketCount,
        poolRaw: P.toString(),
        jackpotRaw: J.toString(),
        skipped,
      }),
    )
  }
}

/** The stored parameters of a round, for recomputation (/fair, breaker verification, rehearsal). */
export function roundParams(r: RoundRow): RoundParams {
  return {
    roundId: r.id,
    poolRaw: r.poolRaw ?? 0n,
    payoutRatePpm: r.payoutRatePpm ?? 0n,
    jackpotSharePpm: r.jackpotSharePpm ?? 0n,
    singlePrizeCapPpm: r.singlePrizeCapPpm ?? 0n,
    roundBreakerPpm: r.roundBreakerPpm ?? 0n,
    jackpotOdds: r.jackpotOdds ?? 50_000n,
    totalWeightMicro: r.totalWeightedMicro ?? 0n,
  }
}

/** Devnet/localnet rehearsal: find a seed whose ticket 0 for `wallet` hits the jackpot (≈ odds tries). */
export function grindJackpotSeed(wallet: string, roundId: number, odds: bigint): Uint8Array {
  for (let i = 0; i < Number(odds) * 20; i++) {
    const seed = generateServerSeed()
    if (deriveTicket(seed, wallet, roundId, 0, odds).jackpot) return seed
  }
  throw new Error('could not grind a jackpot seed')
}
