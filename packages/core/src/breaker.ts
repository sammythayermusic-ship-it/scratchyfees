import type { EconomyConfig } from './config'
import { E18, mulDivCeil, pow10 } from './units'

/**
 * PLAN.md §2.5 — safety clamps (automatic, no human).
 *  - single prize ≤ 5% of pool            → see budget.tierPrizeRaw (applies to ticket prizes)
 *  - realized ticket payouts > 3 × B      → pause payouts + alert (decision E: auto-verify then resume)
 *  - pool < MIN_POOL_RESERVE (USD→PUMP)   → pause
 *  - PRIZE wallet SOL < MIN_GAS_SOL       → pause
 * Decision B: the jackpot is paid from its own earmarked pot and is exempt from the 5% clamp and the
 * 3×B breaker; it has its own guard (payout == recorded pot, wallet covers it).
 */

/** True when paying `nextPrizeRaw` would push the round's realized ticket payouts above the limit. */
export function wouldTripBreaker(
  realizedRaw: bigint,
  nextPrizeRaw: bigint,
  breakerLimitRaw: bigint,
): boolean {
  return realizedRaw + nextPrizeRaw > breakerLimitRaw
}

/**
 * MIN_POOL_RESERVE_USD converted to raw PUMP at a USD price scaled by 1e18.
 * Returns null when no price is known (caller keeps the last computed reserve).
 */
export function poolReserveRaw(
  cfg: EconomyConfig,
  pumpPriceUsdE18: bigint | null,
  pumpDecimals: number,
): bigint | null {
  if (pumpPriceUsdE18 === null || pumpPriceUsdE18 <= 0n) return null
  // reserve tokens = USD / price;  raw = USD × 10^dec × 1e18 / priceE18  (round up — conservative)
  return mulDivCeil(cfg.minPoolReserveUsd * pow10(pumpDecimals), E18, pumpPriceUsdE18)
}

/**
 * Pause/resume with hysteresis so a balance hovering at the threshold doesn't flap:
 * pause when value < threshold, resume only once value ≥ threshold × (1 + hysteresis).
 */
export function hysteresisState(
  currentlyPaused: boolean,
  value: bigint,
  threshold: bigint,
  hysteresisPpm: bigint = 100_000n,
): boolean {
  if (!currentlyPaused) return value < threshold
  const resumeAt = threshold + (threshold * hysteresisPpm) / 1_000_000n
  return value < resumeAt
}

export function gasBelowMinimum(lamports: bigint, cfg: EconomyConfig): boolean {
  return lamports < cfg.minGasLamports
}

export type PauseReason =
  'manual' | 'breaker' | 'breaker_mismatch' | 'low_pool' | 'low_gas' | 'invariant' | 'mint_extension'

/** Reasons that clear themselves when the underlying condition recovers. */
export const AUTO_RESUME_REASONS: ReadonlySet<PauseReason> = new Set(['low_pool', 'low_gas', 'breaker'])
