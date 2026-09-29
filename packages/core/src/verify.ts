import type { EconomyConfig } from './config'
import { tierPrizeRaw, type RoundBudget } from './budget'
import { deriveTicket, seedFromHex, verifySeedCommitment } from './fair'
import { TIERS, type TierId } from './odds'
import { mulDivFloor, PPM } from './units'

/**
 * Everything needed to recompute any ticket of a finished round. The round stores its OWN parameters
 * (a later PAYOUT_RATE change can never break verification of an old round).
 */
export interface RoundParams {
  roundId: number
  /** P — pool snapshot at round start (raw PUMP) */
  poolRaw: bigint
  payoutRatePpm: bigint
  jackpotSharePpm: bigint
  singlePrizeCapPpm: bigint
  roundBreakerPpm: bigint
  jackpotOdds: bigint
  /** W — Σ tickets × mult over all entries (micro-units) */
  totalWeightMicro: bigint
}

export function roundParamsFromConfig(
  roundId: number,
  poolRaw: bigint,
  totalWeightMicro: bigint,
  cfg: EconomyConfig,
): RoundParams {
  return {
    roundId,
    poolRaw,
    payoutRatePpm: cfg.payoutRatePpm,
    jackpotSharePpm: cfg.jackpotSharePpm,
    singlePrizeCapPpm: cfg.singlePrizeCapPpm,
    roundBreakerPpm: cfg.roundBreakerPpm,
    jackpotOdds: cfg.jackpotOdds,
    totalWeightMicro,
  }
}

/** Budget derived purely from stored round params (same arithmetic as budget.roundBudget). */
export function budgetFromParams(p: RoundParams): RoundBudget {
  const budgetRaw = mulDivFloor(p.poolRaw, p.payoutRatePpm, PPM)
  const jackpotAccrualRaw = mulDivFloor(budgetRaw, p.jackpotSharePpm, PPM)
  return {
    poolRaw: p.poolRaw,
    budgetRaw,
    jackpotAccrualRaw,
    ticketBudgetRaw: budgetRaw - jackpotAccrualRaw,
    singlePrizeCapRaw: mulDivFloor(p.poolRaw, p.singlePrizeCapPpm, PPM),
    breakerLimitRaw: mulDivFloor(budgetRaw, p.roundBreakerPpm, PPM),
  }
}

export interface RecomputedTicket {
  tier: TierId
  jackpot: boolean
  /** tier prize in raw PUMP (the jackpot amount is the pot at reveal, recorded separately) */
  prizeRaw: bigint
  digestHex: string
}

/** Canonical recomputation of one ticket — used by /fair, the breaker auto-verify and the rehearsal. */
export function recomputeTicket(
  seedHex: string,
  wallet: string,
  ticketIdx: number,
  multMicro: bigint,
  params: RoundParams,
): RecomputedTicket {
  const d = deriveTicket(seedFromHex(seedHex), wallet, params.roundId, ticketIdx, params.jackpotOdds)
  const budget = budgetFromParams(params)
  return {
    tier: d.tier,
    jackpot: d.jackpot,
    prizeRaw: tierPrizeRaw(TIERS[d.tier]!.k10, budget, multMicro, params.totalWeightMicro),
    digestHex: d.digestHex,
  }
}

/** Seed reveal check: the revealed seed must hash to the commitment published before the round. */
export function seedMatchesCommitment(seedHex: string, commitmentHex: string): boolean {
  return verifySeedCommitment(seedHex, commitmentHex)
}
