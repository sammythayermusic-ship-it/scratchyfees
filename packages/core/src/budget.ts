import { JACKPOT_SEED_PPM, type EconomyConfig } from './config'
import { TIERS, type TierId } from './odds'
import { maxBig, minBig, mulDivFloor, PPM } from './units'

/**
 * PLAN.md §2.2 / §2.4 / §2.5 — rounds, budget, jackpot, clamps. All amounts are raw PUMP base units.
 *
 *   P  = pool snapshot at round start (PUMP)
 *   B  = PAYOUT_RATE × P
 *   B splits 90% ticket prizes / 10% → progressive jackpot pot J
 *   e  = 0.9 × B / W                         (per-weighted-ticket expected value)
 *   ticket prize = k × e × mult              (k from the odds table)
 *   any single prize ≤ 5% of the pool        (SINGLE_PRIZE_CAP, evaluated on the snapshot P)
 *   breaker: realized ticket payouts > 3 × B → pause
 */

export interface PoolSnapshotInput {
  /** PRIZE wallet PUMP balance at the snapshot (finalized commitment) */
  walletBalanceRaw: bigint
  /** progressive jackpot pot J (earmarked inside the same wallet) */
  jackpotRaw: bigint
  /** payouts owed but not yet landed by the snapshot slot */
  outstandingRaw: bigint
}

/** P = wallet balance − J − outstanding (never negative). */
export function poolSnapshot({ walletBalanceRaw, jackpotRaw, outstandingRaw }: PoolSnapshotInput): bigint {
  return maxBig(0n, walletBalanceRaw - jackpotRaw - outstandingRaw)
}

export interface RoundBudget {
  /** P */
  poolRaw: bigint
  /** B = PAYOUT_RATE × P */
  budgetRaw: bigint
  /** 10% of B that accrues to the jackpot pot this round */
  jackpotAccrualRaw: bigint
  /** 90% of B for ticket prizes (B − jackpot accrual, so the split is exact) */
  ticketBudgetRaw: bigint
  /** SINGLE_PRIZE_CAP × P */
  singlePrizeCapRaw: bigint
  /** ROUND_BREAKER × B */
  breakerLimitRaw: bigint
}

export function roundBudget(poolRaw: bigint, cfg: EconomyConfig): RoundBudget {
  if (poolRaw < 0n) throw new RangeError('pool must be >= 0')
  const budgetRaw = mulDivFloor(poolRaw, cfg.payoutRatePpm, PPM)
  const jackpotAccrualRaw = mulDivFloor(budgetRaw, cfg.jackpotSharePpm, PPM)
  return {
    poolRaw,
    budgetRaw,
    jackpotAccrualRaw,
    ticketBudgetRaw: budgetRaw - jackpotAccrualRaw,
    singlePrizeCapRaw: mulDivFloor(poolRaw, cfg.singlePrizeCapPpm, PPM),
    breakerLimitRaw: mulDivFloor(budgetRaw, cfg.roundBreakerPpm, PPM),
  }
}

/**
 * Exact ticket prize for tier k (in tenths of e) on a wallet with multiplier `multMicro`:
 *   prize = min( floor(k10 × ticketBudget × mult_µ / (10 × W_µ)),  singlePrizeCap )
 * One floor only, so rounding loses < 1 base unit per ticket.
 */
export function tierPrizeRaw(
  k10: bigint,
  budget: Pick<RoundBudget, 'ticketBudgetRaw' | 'singlePrizeCapRaw'>,
  multMicro: bigint,
  totalWeightMicro: bigint,
): bigint {
  if (k10 === 0n || totalWeightMicro === 0n) return 0n
  const raw = (k10 * budget.ticketBudgetRaw * multMicro) / (10n * totalWeightMicro)
  return minBig(raw, budget.singlePrizeCapRaw)
}

/** Prize for every tier (index = tier id) for one wallet's multiplier. */
export function prizeTableRaw(budget: RoundBudget, multMicro: bigint, totalWeightMicro: bigint): bigint[] {
  return TIERS.map((t) => tierPrizeRaw(t.k10, budget, multMicro, totalWeightMicro))
}

export function prizeForTierRaw(
  tier: TierId,
  budget: RoundBudget,
  multMicro: bigint,
  totalWeightMicro: bigint,
): bigint {
  return tierPrizeRaw(TIERS[tier]!.k10, budget, multMicro, totalWeightMicro)
}

/** e (per weighted ticket, mult 1) as an exact rational: ticketBudget / W. */
export function perWeightedTicketEv(
  budget: RoundBudget,
  totalWeightMicro: bigint,
): { num: bigint; den: bigint } {
  return { num: budget.ticketBudgetRaw * 1_000_000n, den: totalWeightMicro === 0n ? 1n : totalWeightMicro }
}

/** §2.4 — "Seed J at launch with 1% of the initial pool." */
export function jackpotSeedRaw(initialPoolRaw: bigint): bigint {
  return mulDivFloor(initialPoolRaw, JACKPOT_SEED_PPM, PPM)
}

/** §2.4 — J accrues 0.1 × B every round (including rounds nobody plays). */
export function accrueJackpot(jackpotRaw: bigint, budget: RoundBudget): bigint {
  return jackpotRaw + budget.jackpotAccrualRaw
}

/** 70/30 fee split (§3): to_prize = floor(total × FEE_SPLIT_POOL), to_ops = remainder — sums exactly. */
export function splitFees(totalRaw: bigint, cfg: EconomyConfig): { toPrizeRaw: bigint; toOpsRaw: bigint } {
  const toPrizeRaw = mulDivFloor(totalRaw, cfg.feeSplitPoolPpm, PPM)
  return { toPrizeRaw, toOpsRaw: totalRaw - toPrizeRaw }
}
