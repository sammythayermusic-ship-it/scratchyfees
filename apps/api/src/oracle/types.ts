/**
 * Dual price oracle (PLAN §3): PUMP/USD (Jupiter → DexScreener) and SCRATCHY/PUMP (pool price).
 * Prices are "units of quote per whole token" × 1e18 as bigints.
 *  fresh  — all prices from live sources within PRICE_CACHE_SECONDS
 *  stale  — a source failed; serving the cached value (still within tolerance)
 *  frozen — all sources failing; eligibility frozen at the last known price (site shows a banner);
 *           payouts continue (they are PUMP-denominated)
 *  none   — no price has ever been known (cold start): reserve check fails closed
 */
export type PriceState = 'fresh' | 'stale' | 'frozen' | 'none'

export interface PriceQuote {
  valueE18: bigint
  source: string
  at: Date
}

export interface PriceSnapshot {
  pumpUsd: PriceQuote | null
  scratchyPump: PriceQuote | null
  /** derived: scratchyPump × pumpUsd */
  scratchyUsd: PriceQuote | null
  state: PriceState
  /** when the last fully-fresh snapshot was taken */
  lastFreshAt: Date | null
}

export interface PriceOracle {
  /** refresh if the cache is older than PRICE_CACHE_SECONDS; never throws */
  get(): Promise<PriceSnapshot>
  /** last snapshot without any I/O */
  peek(): PriceSnapshot
}

/** A single PUMP/USD source. Returns null when it has no reliable price; throws on transport errors. */
export interface UsdPriceSource {
  readonly name: string
  fetchUsdPriceE18(mint: string): Promise<bigint | null>
}
