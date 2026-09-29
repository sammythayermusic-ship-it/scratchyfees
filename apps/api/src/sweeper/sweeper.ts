import { splitFees, type EconomyConfig } from '@scratchy/core'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Alerter } from '../alerts/types'
import type { ChainClient } from '../chain/types'
import type { Db } from '../db/client'
import { payouts, sweeps } from '../db/schema'
import type { SwapAdapter, VenueAdapter } from '../venue/types'

/**
 * PLAN §3 fee sweeper (every SWEEP_INTERVAL_MIN): claim the pool's accrued fees to CREATOR via the venue
 * adapter → swap ONLY the SCRATCHY that the claim delivered to PUMP (never CREATOR's own bag; no-op under
 * collectFeeMode = OnlyB) → split 70% → PRIZE / 30% → OPS. The split transfers are CREATOR-signed rows in the
 * payouts queue, so they get the payout engine's exactly-once guarantees.
 *
 * Every step is recorded on the `sweeps` row and resumed on the next run:
 *   claiming → claimed → (swap) → split → done        (failed = the claim itself failed; nothing moved)
 * A swap failure leaves the SCRATCHY in CREATOR, alerts, and retries next run — the PUMP part is split anyway.
 */

type SweepRow = typeof sweeps.$inferSelect

export interface SweeperDeps {
  db: Db
  chain: ChainClient
  venue: VenueAdapter
  swap: SwapAdapter
  alerter: Alerter
  economy: EconomyConfig
  creatorAddress: string
  prizeAddress: string
  opsAddress: string
  quoteMint: string
  maxSlippageBps: number
  /** wake the payout worker after queuing split transfers */
  onQueued?: () => void
}

export interface SweepOutcome {
  claimed: SweepRow | null
  advanced: number
}

export class FeeSweeper {
  constructor(private readonly d: SweeperDeps) {}

  async runOnce(): Promise<SweepOutcome> {
    // 1. finish anything left over from earlier runs (crashes, swap failures, transfers still in flight)
    const open = await this.d.db
      .select()
      .from(sweeps)
      .where(inArray(sweeps.status, ['claiming', 'claimed', 'split']))
      .orderBy(asc(sweeps.id))
    for (const s of open) {
      if (s.status === 'claiming') {
        // we crashed mid-claim: we cannot know what landed → never guess; flag it for the orphan check
        await this.d.db
          .update(sweeps)
          .set({ status: 'failed', error: 'interrupted during claim (see orphan check)', updatedAt: new Date() })
          .where(eq(sweeps.id, s.id))
        continue
      }
      await this.advance(s)
    }

    // 2. claim new fees
    let claimedRow: SweepRow | null = null
    const pending = await this.d.venue.pendingFees()
    if (pending.quoteRaw > 0n || pending.baseRaw > 0n) {
      const [row] = await this.d.db.insert(sweeps).values({ status: 'claiming' }).returning()
      try {
        const claim = await this.d.venue.claimFees()
        const share = await this.d.venue.creatorLiquidityShare().catch(() => NaN)
        const [updated] = await this.d.db
          .update(sweeps)
          .set({
            status: 'claimed',
            claimedPumpRaw: claim.claimedQuoteRaw,
            claimedScratchyRaw: claim.claimedBaseRaw,
            txSigs: claim.signatures,
            updatedAt: new Date(),
          })
          .where(eq(sweeps.id, row!.id))
          .returning()
        claimedRow = updated!
        this.d.alerter.notify({
          kind: 'sweep.claimed',
          severity: 'info',
          message: `sweep #${row!.id}: claimed ${claim.claimedQuoteRaw} raw PUMP + ${claim.claimedBaseRaw} raw SCRATCHY (CREATOR LP share ${Number.isFinite(share) ? (share * 100).toFixed(1) + '%' : 'n/a'})`,
          data: { sweepId: row!.id.toString(), signatures: claim.signatures },
        })
        await this.advance(updated!)
      } catch (e) {
        await this.d.db
          .update(sweeps)
          .set({ status: 'failed', error: (e as Error).message, updatedAt: new Date() })
          .where(eq(sweeps.id, row!.id))
        this.d.alerter.notify({
          kind: 'sweep.claim_failed',
          severity: 'warn',
          message: `sweep #${row!.id}: fee claim failed — ${(e as Error).message}`,
          immediate: true,
          dedupeKey: 'sweep.claim_failed',
        })
      }
    }

    await this.orphanCheck()
    return { claimed: claimedRow, advanced: open.length }
  }

  /** Swap (if needed) → queue the 70/30 split of whatever PUMP is known → mark done when transfers land. */
  private async advance(s: SweepRow): Promise<void> {
    let row = s
    const swapOutstanding = row.claimedScratchyRaw - row.swapInScratchyRaw
    if (swapOutstanding > 0n) {
      try {
        const res = await this.d.swap.swapBaseToQuote(swapOutstanding, this.d.maxSlippageBps)
        if (res.inRaw > swapOutstanding) throw new Error(`swap consumed ${res.inRaw} > claimed ${swapOutstanding}`)
        const [u] = await this.d.db
          .update(sweeps)
          .set({
            swapInScratchyRaw: row.swapInScratchyRaw + res.inRaw,
            swapOutPumpRaw: row.swapOutPumpRaw + res.outRaw,
            txSigs: [...row.txSigs, res.signature].filter(Boolean),
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(sweeps.id, row.id))
          .returning()
        row = u!
      } catch (e) {
        await this.d.db
          .update(sweeps)
          .set({ error: `swap: ${(e as Error).message}`, updatedAt: new Date() })
          .where(eq(sweeps.id, row.id))
        this.d.alerter.notify({
          kind: 'sweep.swap_failed',
          severity: 'warn',
          message: `sweep #${row.id}: SCRATCHY→PUMP swap failed (${(e as Error).message}); SCRATCHY stays in CREATOR, retrying next sweep`,
          immediate: true,
          dedupeKey: 'sweep.swap_failed',
        })
      }
    }

    // queue the split of any PUMP not yet split (claimed PUMP now; swap output whenever it arrives)
    const knownPump = row.claimedPumpRaw + row.swapOutPumpRaw
    const remaining = knownPump - row.toPrizeRaw - row.toOpsRaw
    if (remaining > 0n) {
      const { toPrizeRaw, toOpsRaw } = splitFees(remaining, this.d.economy)
      const queued = await this.d.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(sweeps).where(eq(sweeps.id, row.id)).for('update')
        if (!locked || locked.toPrizeRaw + locked.toOpsRaw !== row.toPrizeRaw + row.toOpsRaw) return null // raced
        const rows = []
        if (toPrizeRaw > 0n)
          rows.push({
            kind: 'sweep_prize',
            signer: 'creator',
            sweepId: row.id,
            wallet: this.d.prizeAddress,
            amountRaw: toPrizeRaw,
            roundId: 0,
            status: 'queued',
          })
        if (toOpsRaw > 0n)
          rows.push({
            kind: 'sweep_ops',
            signer: 'creator',
            sweepId: row.id,
            wallet: this.d.opsAddress,
            amountRaw: toOpsRaw,
            roundId: 0,
            status: 'queued',
          })
        if (rows.length) await tx.insert(payouts).values(rows)
        const [u] = await tx
          .update(sweeps)
          .set({
            status: 'split',
            totalPumpRaw: knownPump,
            toPrizeRaw: locked.toPrizeRaw + toPrizeRaw,
            toOpsRaw: locked.toOpsRaw + toOpsRaw,
            updatedAt: new Date(),
          })
          .where(eq(sweeps.id, row.id))
          .returning()
        return u!
      })
      if (queued) {
        row = queued
        this.d.onQueued?.()
      }
    }

    // done once the swap is complete and every split transfer has landed
    if (row.claimedScratchyRaw === row.swapInScratchyRaw) {
      const transfers = await this.d.db
        .select({ status: payouts.status })
        .from(payouts)
        .where(and(eq(payouts.sweepId, row.id), inArray(payouts.kind, ['sweep_prize', 'sweep_ops'])))
      if (transfers.every((t) => t.status === 'confirmed') && row.status !== 'done') {
        await this.d.db.update(sweeps).set({ status: 'done', updatedAt: new Date() }).where(eq(sweeps.id, row.id))
        this.d.alerter.notify({
          kind: 'sweep.done',
          severity: 'info',
          message: `sweep #${row.id} done: ${row.toPrizeRaw} raw PUMP → PRIZE, ${row.toOpsRaw} raw PUMP → OPS`,
        })
      }
    }
  }

  /**
   * CREATOR should hold only PUMP that sweeps know about (a dedicated fee wallet). Anything more — e.g. a
   * claim that landed while we crashed — is flagged for the operator (never auto-split: we don't guess).
   */
  private async orphanCheck(): Promise<void> {
    try {
      const bal = await this.d.chain.getTokenBalance(this.d.creatorAddress, this.d.quoteMint)
      const [{ owed }] = (await this.d.db.execute<{ owed: string }>(sql`
        SELECT COALESCE(SUM(amount_raw), 0)::text AS owed FROM payouts
        WHERE signer = 'creator' AND status NOT IN ('confirmed', 'failed_permanent')`)).rows as [{ owed: string }]
      const expected = BigInt(owed)
      if (bal.value > expected) {
        this.d.alerter.notify({
          kind: 'sweep.orphan',
          severity: 'warn',
          message: `CREATOR holds ${bal.value - expected} raw PUMP not attributable to any sweep (interrupted claim or a deposit) — review before splitting`,
          dedupeKey: 'sweep.orphan',
        })
      }
    } catch {
      /* best effort */
    }
  }
}
