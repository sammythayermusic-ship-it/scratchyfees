import { sql } from 'drizzle-orm'
import type { Db } from './client'

/**
 * PUMP that is inside the PRIZE wallet but not part of the free pool P:
 *   jackpot pot J  +  prize payouts owed but not yet landed.
 * With `slot` (the context slot of a finalized balance read): a confirmed payout counts as outstanding if it
 * landed AFTER that slot (it is still inside that balance) — the same predicate the round engine uses, so the
 * balance and the liabilities describe the same moment. failed_permanent payouts never leave the pool.
 */
export async function reservedRaw(
  db: Db,
  slot?: number,
): Promise<{ jackpotRaw: bigint; outstandingRaw: bigint }> {
  const landedFilter =
    slot === undefined ? sql`status <> 'confirmed'` : sql`(status <> 'confirmed' OR landed_slot > ${slot})`
  const res = await db.execute<{ jackpot: string | null; outstanding: string | null }>(sql`
    SELECT
      (SELECT amount_raw::text FROM jackpot WHERE id = 1) AS jackpot,
      (SELECT COALESCE(SUM(amount_raw), 0)::text FROM payouts
         WHERE signer = 'prize' AND status <> 'failed_permanent' AND ${landedFilter}) AS outstanding`)
  const row = res.rows[0]
  return { jackpotRaw: BigInt(row?.jackpot ?? '0'), outstandingRaw: BigInt(row?.outstanding ?? '0') }
}
