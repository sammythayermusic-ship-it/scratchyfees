import { MULT_DIVISOR_USD, TICKET_BLOCK_USD, type EconomyConfig } from './config'
import { clampBig, E18, MICRO, minBig, pow10 } from './units'

/**
 * PLAN.md §2.1 — eligibility & tickets. LOCKED formulas:
 *   minimum to play:  H ≥ $50
 *   tickets:          min(floor(H / 50) × 5, 100)
 *   whale multiplier: mult = clamp(H / 1000, 1, 25)      (applies to every prize on that wallet's tickets)
 *   weighted tickets: w = tickets × mult;   W = Σ w
 *
 * H is carried as micro-USD (bigint). mult is carried as micro-units (1.0 = 1_000_000n), floor-rounded.
 */

/** H in micro-USD from a raw token balance and a USD price scaled by 1e18 (USD per whole token). */
export function holdingsUsdMicro(balanceRaw: bigint, decimals: number, priceUsdE18: bigint): bigint {
  if (balanceRaw < 0n || priceUsdE18 < 0n) throw new RangeError('holdings/price must be >= 0')
  // raw / 10^dec tokens × price/1e18 USD × 1e6 micro  =  raw × price / 10^(dec + 12)
  return (balanceRaw * priceUsdE18) / pow10(decimals + 12)
}

/** Multiply two 1e18-scaled prices (e.g. SCRATCHY/PUMP × PUMP/USD → SCRATCHY/USD). */
export function mulPriceE18(a: bigint, b: bigint): bigint {
  return (a * b) / E18
}

export function isEligible(hUsdMicro: bigint, cfg: EconomyConfig): boolean {
  return hUsdMicro >= cfg.minHoldUsd * MICRO
}

/** tickets = min(floor(H / 50) × TICKETS_PER_50, TICKET_CAP), 0 when below MIN_HOLD_USD. */
export function ticketsFor(hUsdMicro: bigint, cfg: EconomyConfig): bigint {
  if (!isEligible(hUsdMicro, cfg)) return 0n
  const blocks = hUsdMicro / (TICKET_BLOCK_USD * MICRO)
  return minBig(blocks * cfg.ticketsPer50, cfg.ticketCap)
}

/** mult (micro-units) = clamp(H / 1000, 1, MULT_CAP), floor-rounded to 1e-6. */
export function multMicroFor(hUsdMicro: bigint, cfg: EconomyConfig): bigint {
  // H_usd / 1000 in micro-units = H_micro / 1000
  return clampBig(hUsdMicro / MULT_DIVISOR_USD, MICRO, cfg.multCap * MICRO)
}

export interface EntryTerms {
  eligible: boolean
  tickets: bigint
  multMicro: bigint
  /** w = tickets × mult, in micro-units */
  weightMicro: bigint
}

export function entryTerms(hUsdMicro: bigint, cfg: EconomyConfig): EntryTerms {
  const eligible = isEligible(hUsdMicro, cfg)
  if (!eligible) return { eligible, tickets: 0n, multMicro: MICRO, weightMicro: 0n }
  const tickets = ticketsFor(hUsdMicro, cfg)
  const multMicro = multMicroFor(hUsdMicro, cfg)
  return { eligible, tickets, multMicro, weightMicro: tickets * multMicro }
}

export function totalWeightMicro(entries: readonly { weightMicro: bigint }[]): bigint {
  return entries.reduce((s, e) => s + e.weightMicro, 0n)
}

/**
 * §2.7 "snapshot tier" used by the reveal-time re-check. The tier is the $50 bracket of H,
 * capped where tickets AND mult stop changing (H ≥ MULT_CAP × $1,000 → bracket 500 at defaults).
 * Below $50 the wallet is simply not eligible (tier 0).
 */
export function holdingsTier(hUsdMicro: bigint, cfg: EconomyConfig): bigint {
  if (!isEligible(hUsdMicro, cfg)) return 0n
  // the bracket where tickets AND mult have both stopped growing (500 at the §9 defaults)
  const multSaturation = (cfg.multCap * MULT_DIVISOR_USD) / TICKET_BLOCK_USD
  const ticketSaturation = (cfg.ticketCap + cfg.ticketsPer50 - 1n) / cfg.ticketsPer50
  const cap = multSaturation > ticketSaturation ? multSaturation : ticketSaturation
  return minBig(hUsdMicro / (TICKET_BLOCK_USD * MICRO), cap)
}

/**
 * §2.7 — "Holdings are re-verified at reveal time: if the wallet dumped below its snapshot tier
 * mid-round, remaining tickets void." Both H values must be computed with the SNAPSHOT price, so a
 * price dip never voids anyone — only selling tokens does.
 */
export function shouldVoidOnRecheck(
  snapshotHUsdMicro: bigint,
  currentHUsdMicro: bigint,
  cfg: EconomyConfig,
): boolean {
  return holdingsTier(currentHUsdMicro, cfg) < holdingsTier(snapshotHUsdMicro, cfg)
}

/**
 * The reveal-time re-check as the API performs it: raw token balances, both valued at the SNAPSHOT price.
 * The live price is deliberately not an input — a price move can never void a ticket.
 */
export function shouldVoidOnRecheckBalances(
  snapshotBalanceRaw: bigint,
  currentBalanceRaw: bigint,
  decimals: number,
  snapshotPriceUsdE18: bigint,
  cfg: EconomyConfig,
): boolean {
  return shouldVoidOnRecheck(
    holdingsUsdMicro(snapshotBalanceRaw, decimals, snapshotPriceUsdE18),
    holdingsUsdMicro(currentBalanceRaw, decimals, snapshotPriceUsdE18),
    cfg,
  )
}

export interface HoldMoreNudge {
  /** how many more USD the nudge talks about (MIN_HOLD_USD, i.e. $50) */
  extraUsd: bigint
  /** additional tickets per drop from holding extraUsd more */
  extraTickets: bigint
  /** multiplier gain (micro-units) from holding extraUsd more (relevant at the ticket cap) */
  multGainMicro: bigint
  /** true when neither tickets nor multiplier would grow (above MULT_CAP × $1,000) */
  maxed: boolean
}

/**
 * §6 loss reveal — "shows how many more tickets $50 more of $SCRATCHY would earn". Computed from the
 * same eligibility functions (no literal 5/50 in UI code). At the 100-ticket cap the gain is in the
 * multiplier instead; above $25k nothing grows.
 */
export function holdMoreNudge(hUsdMicro: bigint, cfg: EconomyConfig): HoldMoreNudge {
  const extraUsd = cfg.minHoldUsd
  const now = entryTerms(hUsdMicro, cfg)
  const next = entryTerms(hUsdMicro + extraUsd * MICRO, cfg)
  const extraTickets = next.tickets - now.tickets
  const multGainMicro = now.eligible ? next.multMicro - now.multMicro : 0n
  return { extraUsd, extraTickets, multGainMicro, maxed: extraTickets === 0n && multGainMicro === 0n }
}
