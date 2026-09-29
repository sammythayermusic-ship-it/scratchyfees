import {
  deriveTicket,
  seedFromHex,
  shouldVoidOnRecheckBalances,
  slotSymbols,
  type EconomyConfig,
  type SymbolKey,
  type TierId,
} from '@scratchy/core'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { Alerter } from '../alerts/types'
import type { ChainClient } from '../chain/types'
import type { Db } from '../db/client'
import { entries, jackpot, payouts, rounds, roundSecrets, tickets, wallets } from '../db/schema'
import type { PriceOracle } from '../oracle/types'
import type { EventBus } from './events'

/**
 * POST /api/scratch — reveal pre-rolled tickets (PLAN §2.7, §3.2, §5; Decisions B, D, E).
 *
 *  1. session must hold the wallet's lock for the live round (§3.2 one scratching session per wallet)
 *  2. holdings re-check BEFORE any DB lock (no locks across RPC): a wallet that sold below its snapshot
 *     tier (valued at the snapshot price) voids all its remaining tickets
 *  3. one short transaction, lock order round → tickets → jackpot pot:
 *       mark revealed · first revealed jackpot hit takes the whole pot · breaker counter updated atomically —
 *       once a round's realized ticket payouts exceed 3×B every later ticket-prize payout in it is HELD
 *       (jackpots are never held by the breaker) · one coalesced transfer for the batch's ticket prizes
 *  4. wake the payout worker; publish winner / jackpot events
 * Re-scratching an already revealed ticket returns its stored outcome (idempotent).
 */

export interface TicketOutcome {
  ticketId: string
  roundId: number
  idx: number
  tier: TierId
  /** the ticket's jackpot roll hit */
  jackpot: boolean
  /** PUMP (raw) this ticket's tier pays */
  prizeRaw: string
  /** PUMP (raw) taken from the pot (0 if another reveal already took it this round) */
  jackpotPrizeRaw: string
  symbols: [SymbolKey, SymbolKey, SymbolKey]
  payoutId: string | null
  jackpotPayoutId: string | null
  /** true when this ticket's prize payout is held by the round breaker (auto-verified at round end) */
  held: boolean
}

export type ScratchResult =
  | { ok: true; roundId: number; wallet: string; outcomes: TicketOutcome[] }
  | {
      ok: false
      error: 'not_found' | 'not_live' | 'not_entered' | 'locked' | 'voided' | 'bad_request'
      message: string
    }

export interface ScratchDeps {
  db: Db
  chain: ChainClient
  oracle: PriceOracle
  bus: EventBus
  alerter: Alerter
  economy: EconomyConfig
  scratchyMint: string
  holdingsCacheSeconds: number
  sessionLockSeconds: number
  wakeWorker: () => void
  now?: () => Date
}

const MAX_BATCH = 100

export class ScratchService {
  private readonly now: () => Date
  private readonly balanceCache = new Map<string, { value: bigint; at: number }>()
  private scratchyDecimals: number | null = null
  private readonly seeds = new Map<number, Uint8Array>()

  constructor(private readonly d: ScratchDeps) {
    this.now = d.now ?? (() => new Date())
  }

  async scratch(sessionId: string, ticketIds: bigint[]): Promise<ScratchResult> {
    const ids = [...new Set(ticketIds.map((t) => t.toString()))].map((t) => BigInt(t))
    if (ids.length === 0 || ids.length > MAX_BATCH) {
      return { ok: false, error: 'bad_request', message: `send 1–${MAX_BATCH} ticket ids` }
    }
    const rows = await this.d.db
      .select()
      .from(tickets)
      .where(inArray(tickets.id, ids))
      .orderBy(asc(tickets.id))
    if (rows.length !== ids.length) return { ok: false, error: 'not_found', message: 'unknown ticket' }
    const roundId = rows[0]!.roundId
    const wallet = rows[0]!.wallet
    if (rows.some((r) => r.roundId !== roundId || r.wallet !== wallet)) {
      return { ok: false, error: 'bad_request', message: 'tickets must belong to one wallet and round' }
    }

    // already revealed → idempotent replay of the stored outcome
    if (rows.every((r) => r.scratchedAt)) {
      return { ok: true, roundId, wallet, outcomes: await this.outcomes(rows) }
    }

    const [round] = await this.d.db.select().from(rounds).where(eq(rounds.id, roundId))
    if (!round || round.status !== 'live')
      return { ok: false, error: 'not_live', message: 'this round has ended' }
    const [entry] = await this.d.db
      .select()
      .from(entries)
      .where(and(eq(entries.roundId, roundId), eq(entries.wallet, wallet)))
    if (!entry) return { ok: false, error: 'not_entered', message: 'no entry for this wallet' }
    if (entry.voidedAt) return { ok: false, error: 'voided', message: entry.voidReason ?? 'tickets voided' }

    const now = this.now()
    const lockHeld = entry.sessionId === sessionId && entry.lockExpiresAt && entry.lockExpiresAt > now
    const lockFree = !entry.sessionId || !entry.lockExpiresAt || entry.lockExpiresAt <= now
    if (!lockHeld && !lockFree) {
      return { ok: false, error: 'locked', message: "this wallet's tickets are being scratched" }
    }

    // ── §2.7 holdings re-check (outside any transaction) ──
    const balance = await this.balance(wallet, ids.length > 1)
    const decimals = await this.decimals()
    const snapshotPrice = BigInt(round.scratchyUsdE18 ?? '0')
    if (shouldVoidOnRecheckBalances(entry.holdingsRaw, balance, decimals, snapshotPrice, this.d.economy)) {
      const reason = 'holdings dropped below your snapshot tier — remaining tickets void'
      await this.d.db.transaction(async (tx) => {
        await tx
          .update(tickets)
          .set({ void: true })
          .where(and(eq(tickets.roundId, roundId), eq(tickets.wallet, wallet), isNull(tickets.scratchedAt)))
        await tx
          .update(entries)
          .set({ voidedAt: now, voidReason: reason })
          .where(and(eq(entries.roundId, roundId), eq(entries.wallet, wallet)))
      })
      this.d.bus.emit({ type: 'void', roundId, wallet, reason })
      return { ok: false, error: 'voided', message: reason }
    }

    const pumpUsd = this.d.oracle.peek().pumpUsd?.valueE18.toString() ?? null
    const result = await this.d.db.transaction(async (tx) => {
      const [r] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update')
      if (!r || r.status !== 'live') return { kind: 'not_live' as const }
      const [e] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.roundId, roundId), eq(entries.wallet, wallet)))
        .for('update')
      if (!e || e.voidedAt) return { kind: 'voided' as const }
      const locked = await tx
        .select()
        .from(tickets)
        .where(inArray(tickets.id, ids))
        .orderBy(asc(tickets.id))
        .for('update')
      const fresh = locked.filter((t) => !t.scratchedAt && !t.void)

      // jackpot: first revealed hit takes the whole pot (Decision B — never held by the breaker)
      const takes = new Map<bigint, bigint>()
      if (fresh.some((t) => t.jackpot)) {
        const [pot] = await tx.select().from(jackpot).where(eq(jackpot.id, 1)).for('update')
        let remaining = pot?.amountRaw ?? 0n
        for (const t of fresh.filter((x) => x.jackpot)) {
          takes.set(t.id, remaining)
          remaining = 0n
        }
        await tx.update(jackpot).set({ amountRaw: remaining, updatedAt: now }).where(eq(jackpot.id, 1))
      }

      // breaker: atomic counter on the locked round row
      const tierTotal = fresh.reduce((s, t) => s + t.prizeRaw, 0n)
      const realized = r.realizedRaw + tierTotal
      const tripsNow = !r.breakerTripped && realized > (r.breakerLimitRaw ?? 0n)
      const held = r.breakerTripped || tripsNow
      await tx
        .update(rounds)
        .set({ realizedRaw: realized, breakerTripped: held })
        .where(eq(rounds.id, roundId))

      let tierPayoutId: bigint | null = null
      if (tierTotal > 0n) {
        const [p] = await tx
          .insert(payouts)
          .values({
            kind: 'tier',
            signer: 'prize',
            wallet,
            amountRaw: tierTotal,
            roundId,
            status: held ? 'held' : 'queued',
            heldReason: held ? 'breaker' : null,
            pumpUsdE18: pumpUsd,
          })
          .returning({ id: payouts.id })
        tierPayoutId = p!.id
      }
      const jackpotPayoutIds = new Map<bigint, bigint>()
      for (const [ticketId, amount] of takes) {
        if (amount <= 0n) continue
        const [p] = await tx
          .insert(payouts)
          .values({
            kind: 'jackpot',
            signer: 'prize',
            wallet,
            amountRaw: amount,
            roundId,
            status: 'queued',
            pumpUsdE18: pumpUsd,
          })
          .returning({ id: payouts.id })
        jackpotPayoutIds.set(ticketId, p!.id)
      }
      for (const t of fresh) {
        await tx
          .update(tickets)
          .set({
            scratchedAt: now,
            jackpotPrizeRaw: takes.get(t.id) ?? 0n,
            payoutId: t.prizeRaw > 0n ? tierPayoutId : null,
            jackpotPayoutId: jackpotPayoutIds.get(t.id) ?? null,
          })
          .where(eq(tickets.id, t.id))
      }
      await tx
        .update(entries)
        .set({
          sessionId,
          lockExpiresAt: new Date(now.getTime() + this.d.sessionLockSeconds * 1000),
          lastScratchAt: now,
        })
        .where(and(eq(entries.roundId, roundId), eq(entries.wallet, wallet)))
      const after = await tx.select().from(tickets).where(inArray(tickets.id, ids)).orderBy(asc(tickets.id))
      return { kind: 'ok' as const, after, fresh, takes, tripsNow, realized, limit: r.breakerLimitRaw ?? 0n }
    })

    if (result.kind === 'not_live') return { ok: false, error: 'not_live', message: 'this round has ended' }
    if (result.kind === 'voided') return { ok: false, error: 'voided', message: 'tickets voided' }

    this.d.wakeWorker()
    const outcomes = await this.outcomes(result.after)
    const [w] = await this.d.db
      .select({ xHandle: wallets.xHandle })
      .from(wallets)
      .where(eq(wallets.address, wallet))
    const at = now.toISOString()
    for (const o of outcomes.filter((x) => result.fresh.some((f) => f.id.toString() === x.ticketId))) {
      if (o.tier === 0 && o.jackpotPrizeRaw === '0') continue
      this.d.bus.emit({
        type: 'winner',
        roundId,
        ticketId: o.ticketId,
        wallet,
        xHandle: w?.xHandle ?? null,
        tier: o.tier,
        multMicro: (entry?.multMicro ?? 0n).toString(),
        prizeRaw: o.prizeRaw,
        jackpot: o.jackpotPrizeRaw !== '0',
        jackpotPrizeRaw: o.jackpotPrizeRaw,
        payoutId: o.payoutId,
        pumpUsdE18: pumpUsd,
        at,
      })
      if (o.jackpotPrizeRaw !== '0') {
        this.d.bus.emit({
          type: 'jackpot',
          roundId,
          wallet,
          xHandle: w?.xHandle ?? null,
          amountRaw: o.jackpotPrizeRaw,
          pumpUsdE18: pumpUsd,
          at,
        })
        this.d.alerter.notify({
          kind: 'win.jackpot',
          severity: 'warn',
          message: `🎰 JACKPOT round ${roundId}: ${o.jackpotPrizeRaw} raw PUMP → ${wallet}`,
          immediate: true,
          data: { amountRaw: o.jackpotPrizeRaw },
        })
      } else if (o.tier >= 4) {
        this.d.alerter.notify({
          kind: 'win.big',
          severity: 'info',
          message: `🚨 tier ${o.tier} win round ${roundId}: ${o.prizeRaw} raw PUMP → ${wallet}`,
          immediate: true,
          data: { amountRaw: o.prizeRaw },
        })
      }
    }
    if (result.tripsNow) {
      this.d.alerter.notify({
        kind: 'breaker.tripped',
        severity: 'warn',
        message: `round ${roundId}: realized ticket payouts ${result.realized} > breaker limit ${result.limit} (ROUND_BREAKER×B) — ticket payouts held; auto-verification at round end`,
        immediate: true,
      })
    }
    return { ok: true, roundId, wallet, outcomes }
  }

  /** Public: stored outcomes for already-revealed tickets (used by /api/enter). */
  outcomesFor(rows: (typeof tickets.$inferSelect)[]): Promise<TicketOutcome[]> {
    return this.outcomes(rows)
  }

  /** Outcomes for revealed tickets (symbols need the still-secret seed, computed server-side). */
  private async outcomes(rows: (typeof tickets.$inferSelect)[]): Promise<TicketOutcome[]> {
    const payoutIds = rows.map((r) => r.payoutId).filter((x): x is bigint => x !== null)
    const heldIds = new Set<string>()
    if (payoutIds.length) {
      const ps = await this.d.db
        .select({ id: payouts.id, status: payouts.status })
        .from(payouts)
        .where(inArray(payouts.id, payoutIds))
      for (const p of ps) if (p.status === 'held') heldIds.add(p.id.toString())
    }
    const out: TicketOutcome[] = []
    for (const r of rows) {
      if (!r.scratchedAt) continue
      const seed = await this.seed(r.roundId)
      const digestHex = seed
        ? deriveTicket(seed, r.wallet, r.roundId, r.idx, this.d.economy.jackpotOdds).digestHex
        : '00'.repeat(32)
      const tookPot = r.jackpotPrizeRaw > 0n
      out.push({
        ticketId: r.id.toString(),
        roundId: r.roundId,
        idx: r.idx,
        tier: r.tier as TierId,
        jackpot: r.jackpot,
        prizeRaw: r.prizeRaw.toString(),
        jackpotPrizeRaw: r.jackpotPrizeRaw.toString(),
        symbols: slotSymbols(r.tier as TierId, tookPot, digestHex),
        payoutId: r.payoutId?.toString() ?? null,
        jackpotPayoutId: r.jackpotPayoutId?.toString() ?? null,
        held: r.payoutId !== null && heldIds.has(r.payoutId.toString()),
      })
    }
    return out
  }

  private async seed(roundId: number): Promise<Uint8Array | null> {
    const cached = this.seeds.get(roundId)
    if (cached) return cached
    const [s] = await this.d.db.select().from(roundSecrets).where(eq(roundSecrets.roundId, roundId))
    if (!s) return null
    const seed = seedFromHex(s.serverSeed)
    this.seeds.set(roundId, seed)
    if (this.seeds.size > 8) this.seeds.delete(this.seeds.keys().next().value!)
    return seed
  }

  private async balance(wallet: string, forceFresh: boolean): Promise<bigint> {
    const cached = this.balanceCache.get(wallet)
    const now = this.now().getTime()
    if (!forceFresh && cached && now - cached.at < this.d.holdingsCacheSeconds * 1000) return cached.value
    const b = await this.d.chain.getTokenBalance(wallet, this.d.scratchyMint)
    this.balanceCache.set(wallet, { value: b.value, at: now })
    if (this.balanceCache.size > 20_000) this.balanceCache.clear()
    return b.value
  }

  private async decimals(): Promise<number> {
    if (this.scratchyDecimals === null)
      this.scratchyDecimals = (await this.d.chain.getMintInfo(this.d.scratchyMint)).decimals
    return this.scratchyDecimals
  }
}
