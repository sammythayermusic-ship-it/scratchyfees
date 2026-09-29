/**
 * Venue adapter (PLAN §1 / §3 fee sweeper): the launch venue is swappable behind this interface.
 * Implementations: `damm-v2` (Meteora DAMM v2 custom pool; devnet + mainnet) and `memory` (tests/local).
 * "base" = $SCRATCHY, "quote" = PUMP. Amounts are raw base units.
 */
export interface PoolState {
  address: string
  baseMint: string
  quoteMint: string
  baseDecimals: number
  quoteDecimals: number
  /** reserves held by the pool vaults (raw) */
  baseReserveRaw: bigint
  quoteReserveRaw: bigint
  /** price of 1 whole SCRATCHY in whole PUMP × 1e18 (from sqrtPrice for DAMM v2, not a reserve ratio) */
  priceQuotePerBaseE18: bigint
  slot: number
}

export interface ClaimResult {
  signatures: string[]
  /** PUMP actually received by CREATOR from the claim (measured from token-balance deltas) */
  claimedQuoteRaw: bigint
  /** SCRATCHY actually received by CREATOR from the claim (0 under collectFeeMode = OnlyB) */
  claimedBaseRaw: bigint
}

export interface VenueAdapter {
  readonly name: string
  /** pool / vault / position addresses — auto-excluded from entries (they hold SCRATCHY but aren't players) */
  excludedAddresses(): string[]
  getPoolState(): Promise<PoolState>
  /** fees claimable by CREATOR right now (raw) */
  pendingFees(): Promise<{ quoteRaw: bigint; baseRaw: bigint }>
  /** claim accrued fees to CREATOR; resolves only once the claim is confirmed */
  claimFees(): Promise<ClaimResult>
  /** CREATOR's share of the pool's liquidity (0..1) — its fee share; logged each sweep */
  creatorLiquidityShare(): Promise<number>
}

export interface SwapResult {
  signature: string
  inRaw: bigint
  outRaw: bigint
}

/** Swaps claimed SCRATCHY → PUMP (Jupiter on mainnet; pool swap on devnet; no-op under OnlyB). */
export interface SwapAdapter {
  readonly name: string
  swapBaseToQuote(amountInRaw: bigint, maxSlippageBps: number): Promise<SwapResult>
}
