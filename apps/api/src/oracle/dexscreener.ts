import { fetchJsonWithTimeout, positivePriceE18, PRICE_FETCH_TIMEOUT_MS, type FetchFn } from './jupiter'
import type { UsdPriceSource } from './types'

/**
 * PUMP/USD fallback from DexScreener (PLAN §3: Jupiter first, DexScreener second).
 *   GET {base}/tokens/v1/solana/<mint> → ARRAY of pairs
 *   { chainId, dexId, pairAddress, baseToken: { address }, quoteToken, priceUsd: "0.005665" | null,
 *     liquidity: { usd } }
 * Only pairs whose BASE token is the mint (so priceUsd is the mint's own price) with a usable priceUsd are
 * considered; the deepest one (highest liquidity.usd) wins. No usable pair → null. Transport errors throw.
 */

interface DexPair {
  chainId?: unknown
  baseToken?: { address?: unknown } | null
  priceUsd?: unknown
  liquidity?: { usd?: unknown } | null
}

export class DexScreenerUsdSource implements UsdPriceSource {
  readonly name = 'dexscreener'
  private readonly base: string

  constructor(
    base: string,
    private readonly fetchImpl: FetchFn = (url, init) => fetch(url, init),
    private readonly timeoutMs = PRICE_FETCH_TIMEOUT_MS,
  ) {
    this.base = base.replace(/\/+$/, '')
  }

  async fetchUsdPriceE18(mint: string): Promise<bigint | null> {
    const url = `${this.base}/tokens/v1/solana/${encodeURIComponent(mint)}`
    const body = await fetchJsonWithTimeout(this.fetchImpl, url, {}, 'dexscreener tokens v1', this.timeoutMs)
    if (!Array.isArray(body)) throw new Error('dexscreener tokens v1: expected an array of pairs')
    return bestPairPriceE18(body as DexPair[], mint)
  }
}

/** The priceUsd (× 1e18) of the highest-liquidity pair whose base token is `mint`, or null. */
export function bestPairPriceE18(pairs: readonly DexPair[], mint: string): bigint | null {
  let best: { price: bigint; liquidityUsd: number } | null = null
  for (const pair of pairs) {
    if (typeof pair !== 'object' || pair === null) continue
    if (pair.chainId !== undefined && pair.chainId !== 'solana') continue
    if (pair.baseToken?.address !== mint) continue
    const price = positivePriceE18(pair.priceUsd)
    if (price === null) continue
    const liq = pair.liquidity?.usd
    const liquidityUsd = typeof liq === 'number' && Number.isFinite(liq) && liq > 0 ? liq : 0
    if (best === null || liquidityUsd > best.liquidityUsd) best = { price, liquidityUsd }
  }
  return best?.price ?? null
}
