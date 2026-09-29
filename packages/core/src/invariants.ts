import type { EconomyConfig } from './config'
import { splitFees } from './budget'

/**
 * Pure accounting invariants (plan: tests + live reconciler). Each returns null when it holds or a
 * human-readable violation string. The API reconciler pauses payouts on any violation.
 */

/** (1) PRIZE wallet balance must cover the jackpot pot plus every payout owed. */
export function liabilitiesCovered(
  walletRaw: bigint,
  jackpotRaw: bigint,
  outstandingRaw: bigint,
): string | null {
  return walletRaw >= jackpotRaw + outstandingRaw
    ? null
    : `wallet ${walletRaw} < jackpot ${jackpotRaw} + outstanding ${outstandingRaw}`
}

/** (5) J(n) = J(n−1) + accrual − jackpot paid, never negative. */
export function jackpotRecurrence(
  prevRaw: bigint,
  accrualRaw: bigint,
  paidRaw: bigint,
  nextRaw: bigint,
): string | null {
  if (nextRaw < 0n) return `jackpot negative: ${nextRaw}`
  return prevRaw + accrualRaw - paidRaw === nextRaw
    ? null
    : `jackpot ${prevRaw} + ${accrualRaw} − ${paidRaw} ≠ ${nextRaw}`
}

/** (6) A tier prize may never exceed the single-prize cap. */
export function prizeWithinCap(prizeRaw: bigint, capRaw: bigint): string | null {
  return prizeRaw <= capRaw ? null : `prize ${prizeRaw} > cap ${capRaw}`
}

/** (8) Sweep shares must sum exactly and follow FEE_SPLIT_POOL. */
export function sweepSplitExact(
  totalRaw: bigint,
  toPrizeRaw: bigint,
  toOpsRaw: bigint,
  cfg: EconomyConfig,
): string | null {
  const expected = splitFees(totalRaw, cfg)
  if (toPrizeRaw + toOpsRaw !== totalRaw) return `sweep ${toPrizeRaw} + ${toOpsRaw} ≠ ${totalRaw}`
  if (toPrizeRaw !== expected.toPrizeRaw) return `sweep prize share ${toPrizeRaw} ≠ ${expected.toPrizeRaw}`
  return null
}

export type BalanceReconciliation =
  | { status: 'ok'; deltaRaw: 0n }
  /** chain holds MORE than the ledger explains: a deposit (seed/top-up) or stranger dust → book it, alert */
  | { status: 'inflow'; deltaRaw: bigint }
  /** chain holds LESS than the ledger explains: an unexplained outflow → hard stop (possible key compromise) */
  | { status: 'outflow'; deltaRaw: bigint }

/**
 * (2) Ledger vs chain. Inflows are normal (the operator funds the pool; anyone can send PUMP to the
 * PRIZE account) and must never pause payouts — they are booked as deposits and join the next P.
 * Only an unexplained outflow is an emergency.
 */
export function reconcileBalances(chainRaw: bigint, ledgerRaw: bigint): BalanceReconciliation {
  if (chainRaw === ledgerRaw) return { status: 'ok', deltaRaw: 0n }
  if (chainRaw > ledgerRaw) return { status: 'inflow', deltaRaw: chainRaw - ledgerRaw }
  return { status: 'outflow', deltaRaw: ledgerRaw - chainRaw }
}
