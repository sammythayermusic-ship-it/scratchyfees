import type { SwapAdapter, SwapResult } from './types'

/**
 * No-op swap for collectFeeMode = OnlyB (plan "Venue"): fees accrue only in PUMP, so the sweeper never
 * has SCRATCHY to sell. A zero-amount call returns zeros (no tx); any non-zero amount means the pool is
 * not OnlyB or something else put SCRATCHY in CREATOR — that must be loud, never silently ignored.
 */
export class NoSwap implements SwapAdapter {
  readonly name = 'none'

  async swapBaseToQuote(amountInRaw: bigint, _maxSlippageBps: number): Promise<SwapResult> {
    if (amountInRaw === 0n) return { signature: '', inRaw: 0n, outRaw: 0n }
    throw new Error(
      `SWAP=none cannot sell ${amountInRaw} raw SCRATCHY: the pool is expected to collect fees only in PUMP ` +
        `(collectFeeMode OnlyB). Configure SWAP=jupiter (mainnet) or a pool swap (devnet) if SCRATCHY fees accrue.`,
    )
  }
}
