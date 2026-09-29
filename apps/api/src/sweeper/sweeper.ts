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
 *
 * Swap safety (review SWP-1/2): CREATOR's SCRATCHY balance is recorded before each claim (its own bag) and a
 * swap can never take CREATOR below it. The swap's signature is persisted as an INTENT before it is sent; on
 * resume that exact signature is resolved first (landed → booked, provably dead → cleared, unknown → wait),
 * so a swap that landed but "failed" client-side is never sold again. In/out amounts are booked from the swap
 * transaction's own token deltas, never from lag-prone balance reads.
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
  /** SCRATCHY mint (for the CREATOR bag baseline) */
  baseMint: string
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
          .set({
            status: 'failed',
            error: 'interrupted during claim (see orphan check)',
            updatedAt: new Date(),
          })
          .where(eq(sweeps.id, s.id))
        continue
      }
      await this.advance(s)
    }

    // 2. claim new fees — but never while our own CREATOR-signed split transfers are still in flight:
    //    the claim amount is measured from CREATOR's balance delta, which an in-flight transfer would distort
    let claimedRow: SweepRow | null = null
    const inFlight = await this.d.db
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(eq(payouts.signer, 'creator'), inArray(payouts.status, ['queued', 'sending', 'held', 'failed'])),
      )
      .limit(1)
    const pending = inFlight.length > 0 ? { quoteRaw: 0n, baseRaw: 0n } : await this.d.venue.pendingFees()
    if (pending.quoteRaw > 0n || pending.baseRaw > 0n) {
      const baseline = (await this.d.chain.getTokenBalance(this.d.creatorAddress, this.d.baseMint)).value
      const [row] = await this.d.db
        .insert(sweeps)
        .values({ status: 'claiming', creatorScratchyBaselineRaw: baseline })
        .returning()
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

    // resolve a persisted swap intent BEFORE anything else — never sell twice
    if (row.swapSig) {
      const r = await this.resolveSwap(row)
      if (r === 'unknown') return
      row = r
    }

    const outstanding = row.claimedScratchyRaw - row.swapInScratchyRaw
    if (outstanding > 0n) {
      const current = (await this.d.chain.getTokenBalance(this.d.creatorAddress, this.d.baseMint)).value
      const baseline = row.creatorScratchyBaselineRaw ?? current - outstanding
      const amount = outstanding < current - baseline ? outstanding : current - baseline
      if (amount <= 0n) {
        this.d.alerter.notify({
          kind: 'sweep.bag_guard',
          severity: 'critical',
          message: `sweep #${row.id}: refusing to swap — it would take CREATOR's SCRATCHY below its pre-claim balance (${baseline})`,
          immediate: true,
          dedupeKey: `sweep.bag_guard.${row.id}`,
        })
      } else {
        try {
          const res = await this.d.swap.swapBaseToQuote(amount, this.d.maxSlippageBps, async (signed) => {
            await this.d.db
              .update(sweeps)
              .set({
                swapSig: signed.signature,
                swapLastValidBlockHeight: BigInt(signed.lastValidBlockHeight),
                swapIntentInRaw: amount,
                updatedAt: new Date(),
              })
              .where(eq(sweeps.id, row.id))
          })
          const [fresh] = await this.d.db.select().from(sweeps).where(eq(sweeps.id, row.id))
          row = fresh!
          if (res.signature && row.swapSig === res.signature) {
            const r = await this.resolveSwap(row)
            if (r === 'unknown') return
            row = r
          }
        } catch (e) {
          const [fresh] = await this.d.db.select().from(sweeps).where(eq(sweeps.id, row.id))
          row = fresh!
          await this.d.db
            .update(sweeps)
            .set({ error: `swap: ${(e as Error).message}`, updatedAt: new Date() })
            .where(eq(sweeps.id, row.id))
          this.d.alerter.notify({
            kind: 'sweep.swap_failed',
            severity: 'warn',
            message: `sweep #${row.id}: SCRATCHY→PUMP swap failed (${(e as Error).message}); ${row.swapSig ? 'its signature will be resolved before any retry' : 'SCRATCHY stays in CREATOR, retrying next sweep'}`,
            immediate: true,
            dedupeKey: 'sweep.swap_failed',
          })
          if (row.swapSig) return
        }
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
        await this.d.db
          .update(sweeps)
          .set({ status: 'done', updatedAt: new Date() })
          .where(eq(sweeps.id, row.id))
        this.d.alerter.notify({
          kind: 'sweep.done',
          severity: 'info',
          message: `sweep #${row.id} done: ${row.toPrizeRaw} raw PUMP → PRIZE, ${row.toOpsRaw} raw PUMP → OPS`,
        })
      }
    }
  }

  /**
   * Resolve the persisted swap intent: landed → book in/out from the tx's own deltas; provably dead (expired
   * and unknown to the ledger) or failed on-chain → clear it; otherwise 'unknown' (wait for the next run).
   */
  private async resolveSwap(row: SweepRow): Promise<SweepRow | 'unknown'> {
    const sig = row.swapSig!
    const st = await this.d.chain.getSignatureStatuses([sig])
    const s = st.statuses[0]
    let landed = false
    if (s) {
      if (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized') return 'unknown'
      landed = s.err === null
    } else {
      const fin = await this.d.chain.getHeightAndSlot('finalized')
      const expired =
        row.swapLastValidBlockHeight !== null &&
        fin.blockHeight > Number(row.swapLastValidBlockHeight) &&
        st.contextSlot >= fin.slot
      if (!expired) return 'unknown'
      if (await this.d.chain.getOwnerTokenDeltas(sig, this.d.creatorAddress)) return 'unknown' // known after all
    }
    let swapIn = row.swapInScratchyRaw
    let swapOut = row.swapOutPumpRaw
    const sigs = [...row.txSigs]
    if (landed) {
      const d = await this.d.chain.getOwnerTokenDeltas(sig, this.d.creatorAddress)
      if (!d) return 'unknown'
      const inRaw = -(d.deltas.get(this.d.baseMint) ?? 0n)
      const outRaw = d.deltas.get(this.d.quoteMint) ?? 0n
      if (inRaw < 0n || outRaw < 0n) {
        this.d.alerter.notify({
          kind: 'sweep.swap_anomaly',
          severity: 'critical',
          message: `sweep #${row.id}: swap ${sig} moved tokens the wrong way (in ${inRaw}, out ${outRaw})`,
          immediate: true,
        })
        return 'unknown'
      }
      swapIn += inRaw
      swapOut += outRaw
      sigs.push(sig)
    }
    const [u] = await this.d.db
      .update(sweeps)
      .set({
        swapInScratchyRaw: swapIn,
        swapOutPumpRaw: swapOut,
        txSigs: sigs,
        swapSig: null,
        swapLastValidBlockHeight: null,
        swapIntentInRaw: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(sweeps.id, row.id))
      .returning()
    return u!
  }

  /**
   * CREATOR should hold only PUMP that sweeps know about (a dedicated fee wallet). Anything more — e.g. a
   * claim that landed while we crashed — is flagged for the operator (never auto-split: we don't guess).
   */
  private async orphanCheck(): Promise<void> {
    try {
      const bal = await this.d.chain.getTokenBalance(this.d.creatorAddress, this.d.quoteMint)
      const [{ owed }] = (
        await this.d.db.execute<{ owed: string }>(sql`
        SELECT COALESCE(SUM(amount_raw), 0)::text AS owed FROM payouts
        WHERE signer = 'creator' AND status NOT IN ('confirmed', 'failed_permanent')`)
      ).rows as [{ owed: string }]
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
