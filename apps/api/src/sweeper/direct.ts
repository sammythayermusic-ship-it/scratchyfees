import { asc, eq, inArray } from 'drizzle-orm'
import type { Alerter } from '../alerts/types'
import type { Db } from '../db/client'
import { prizeLedger, sweeps } from '../db/schema'
import type { VenueAdapter } from '../venue/types'
import type { SweepOutcome, Sweeper } from './sweeper'

/**
 * Fee sweeper for venues that pay the shares out THEMSELVES (`VenueAdapter.distributesDirectly`): the
 * pump.fun sharing config sends 70% of every claim straight to PRIZE and 30% straight to OPS in the claim
 * transaction. So a sweep here is one step — claim → book — with nothing to swap and nothing to split:
 *
 *   sweeps row 'claiming' → venue.claimFees() (PRIZE signs the permissionless distribution)
 *     → in ONE db transaction: prize_ledger `sweep_in` (PRIZE's measured delta, at the landing slot)
 *       + the sweeps row → 'done' (claimed = PRIZE + OPS deltas, toPrize / toOps as measured)
 *
 * The ledger entry is what keeps the reconciler's invariant exact: the reconciler holds off booking PRIZE
 * inflows while a sweep is 'claiming' (so a claim that landed a moment before this booking is never counted
 * twice), and it books any inflow it can't explain as `external_in` — which is exactly what happens to a
 * claim interrupted by a crash (row → 'failed', the PUMP still joins the pool, an alert says so).
 */

export interface DirectSweeperDeps {
  db: Db
  venue: VenueAdapter
  alerter: Alerter
  prizeAddress: string
  opsAddress: string
}

export class DirectFeeSweeper implements Sweeper {
  constructor(private readonly d: DirectSweeperDeps) {}

  async runOnce(): Promise<SweepOutcome> {
    // 1. a crash mid-claim: we cannot know what landed → never guess. The reconciler books whatever
    //    arrived as external_in (it joins the next pool), so nothing is lost — just unattributed.
    const open = await this.d.db
      .select()
      .from(sweeps)
      .where(inArray(sweeps.status, ['claiming']))
      .orderBy(asc(sweeps.id))
    for (const s of open) {
      await this.d.db
        .update(sweeps)
        .set({
          status: 'failed',
          error: 'interrupted during claim (any PUMP that landed is booked by the reconciler as external_in)',
          updatedAt: new Date(),
        })
        .where(eq(sweeps.id, s.id))
      this.d.alerter.notify({
        kind: 'sweep.interrupted',
        severity: 'warn',
        message: `sweep #${s.id} was interrupted mid-claim; if its PUMP landed it joins the pool as an unexplained inflow`,
        dedupeKey: `sweep.interrupted.${s.id}`,
      })
    }

    // 2. claim whatever is waiting
    const pending = await this.d.venue.pendingFees()
    if (pending.quoteRaw <= 0n) return { claimed: null, advanced: open.length }
    const [row] = await this.d.db.insert(sweeps).values({ status: 'claiming' }).returning()
    const id = row!.id
    try {
      const claim = await this.d.venue.claimFees()
      const dist = claim.distributed
      if (!dist) throw new Error(`venue ${this.d.venue.name} did not report the distributed amounts`)
      const total = dist.toPrizeRaw + dist.toOpsRaw
      const updated = await this.d.db.transaction(async (tx) => {
        if (dist.toPrizeRaw > 0n) {
          await tx
            .insert(prizeLedger)
            .values({
              kind: 'sweep_in',
              amountRaw: dist.toPrizeRaw,
              ref: `sweep:${id}`,
              slot: BigInt(dist.slot),
            })
            .onConflictDoNothing()
        }
        const [u] = await tx
          .update(sweeps)
          .set({
            status: 'done',
            claimedPumpRaw: total,
            claimedScratchyRaw: 0n,
            totalPumpRaw: total,
            toPrizeRaw: dist.toPrizeRaw,
            toOpsRaw: dist.toOpsRaw,
            txSigs: claim.signatures,
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(sweeps.id, id))
          .returning()
        return u!
      })
      this.d.alerter.notify({
        kind: 'sweep.done',
        severity: 'info',
        message: `sweep #${id} done: claimed ${total} raw PUMP — ${dist.toPrizeRaw} → PRIZE, ${dist.toOpsRaw} → OPS (paid out by the venue itself)`,
        data: { sweepId: id.toString(), signatures: claim.signatures },
      })
      return { claimed: updated, advanced: open.length }
    } catch (e) {
      await this.d.db
        .update(sweeps)
        .set({ status: 'failed', error: (e as Error).message, updatedAt: new Date() })
        .where(eq(sweeps.id, id))
      this.d.alerter.notify({
        kind: 'sweep.claim_failed',
        severity: 'warn',
        message: `sweep #${id}: fee claim failed — ${(e as Error).message}`,
        immediate: true,
        dedupeKey: 'sweep.claim_failed',
      })
      return { claimed: null, advanced: open.length }
    }
  }
}
