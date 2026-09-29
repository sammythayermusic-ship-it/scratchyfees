import type { MemoryChainClient } from '../chain/memory'
import type { ClaimResult, PoolState, SwapAdapter, SwapResult, VenueAdapter } from './types'

/**
 * In-memory stand-in for the launch venue (tests, local dev with CHAIN_MODE=memory, load tests).
 * A full-range constant-product SCRATCHY/PUMP pool with a POOL_TRADING_FEE fee, the venue's protocol cut,
 * and Meteora-style fee collection modes:
 *   OnlyB     — the fee is always taken in PUMP (quote) → claims deliver only PUMP (our launch config)
 *   BothToken — the fee is taken in the input token → claims deliver PUMP and SCRATCHY (exercises the swap)
 * Claimed fees are credited to CREATOR in the MemoryChainClient ledger.
 */

export const MEMORY_POOL_ADDRESS = 'MemoryPoo1111111111111111111111111111111111'

export interface MemoryVenueOptions {
  chain: MemoryChainClient
  creator: string
  baseMint: string
  quoteMint: string
  baseDecimals: number
  quoteDecimals: number
  baseReserveRaw: bigint
  quoteReserveRaw: bigint
  /** POOL_TRADING_FEE in ppm (30_000 = 3%) */
  feePpm?: bigint
  /** venue protocol share of the fee in ppm (Meteora keeps 20%) */
  protocolCutPpm?: bigint
  collectFeeMode?: 'OnlyB' | 'BothToken'
}

export class MemoryVenue implements VenueAdapter {
  readonly name = 'memory'
  private base: bigint
  private quote: bigint
  private pendingBase = 0n
  private pendingQuote = 0n
  private readonly feePpm: bigint
  private readonly cutPpm: bigint
  private readonly mode: 'OnlyB' | 'BothToken'
  /** claims fail this many more times (tests) */
  failClaimsNext = 0

  constructor(private readonly o: MemoryVenueOptions) {
    this.base = o.baseReserveRaw
    this.quote = o.quoteReserveRaw
    this.feePpm = o.feePpm ?? 30_000n
    this.cutPpm = o.protocolCutPpm ?? 200_000n
    this.mode = o.collectFeeMode ?? 'OnlyB'
  }

  excludedAddresses(): string[] {
    return [MEMORY_POOL_ADDRESS]
  }

  async getPoolState(): Promise<PoolState> {
    // price of 1 whole SCRATCHY in whole PUMP × 1e18
    const scale = 10n ** 18n * 10n ** BigInt(this.o.baseDecimals)
    const price = (this.quote * scale) / (this.base * 10n ** BigInt(this.o.quoteDecimals))
    return {
      address: MEMORY_POOL_ADDRESS,
      baseMint: this.o.baseMint,
      quoteMint: this.o.quoteMint,
      baseDecimals: this.o.baseDecimals,
      quoteDecimals: this.o.quoteDecimals,
      baseReserveRaw: this.base,
      quoteReserveRaw: this.quote,
      priceQuotePerBaseE18: price,
      slot: await this.o.chain.getSlot(),
    }
  }

  async pendingFees(): Promise<{ quoteRaw: bigint; baseRaw: bigint }> {
    return { quoteRaw: this.pendingQuote, baseRaw: this.pendingBase }
  }

  async claimFees(): Promise<ClaimResult> {
    if (this.failClaimsNext > 0) {
      this.failClaimsNext--
      throw new Error('memory venue: claim failed (injected)')
    }
    const q = this.pendingQuote
    const b = this.pendingBase
    this.pendingQuote = 0n
    this.pendingBase = 0n
    if (q > 0n) this.o.chain.credit(this.o.creator, this.o.quoteMint, q)
    if (b > 0n) this.o.chain.credit(this.o.creator, this.o.baseMint, b)
    return { signatures: q > 0n || b > 0n ? [`mem-claim-${Date.now()}`] : [], claimedQuoteRaw: q, claimedBaseRaw: b }
  }

  async creatorLiquidityShare(): Promise<number> {
    return 1
  }

  /** Simulated market trade (fake fee inflow in memory mode). Returns the amount out. */
  trade(side: 'buy' | 'sell', amountInRaw: bigint): bigint {
    if (amountInRaw <= 0n) return 0n
    const lpShare = (fee: bigint) => fee - (fee * this.cutPpm) / 1_000_000n
    if (side === 'buy') {
      // PUMP in → SCRATCHY out; fee on the PUMP input (both modes)
      const fee = (amountInRaw * this.feePpm) / 1_000_000n
      const inNet = amountInRaw - fee
      const out = (this.base * inNet) / (this.quote + inNet)
      this.quote += inNet
      this.base -= out
      this.pendingQuote += lpShare(fee)
      return out
    }
    // SCRATCHY in → PUMP out
    if (this.mode === 'BothToken') {
      const fee = (amountInRaw * this.feePpm) / 1_000_000n
      const inNet = amountInRaw - fee
      const out = (this.quote * inNet) / (this.base + inNet)
      this.base += inNet
      this.quote -= out
      this.pendingBase += lpShare(fee)
      return out
    }
    const grossOut = (this.quote * amountInRaw) / (this.base + amountInRaw)
    const fee = (grossOut * this.feePpm) / 1_000_000n
    this.base += amountInRaw
    this.quote -= grossOut
    this.pendingQuote += lpShare(fee)
    return grossOut - fee
  }
}

/** Swap SCRATCHY → PUMP through the memory pool for CREATOR (moves CREATOR's ledger balances). */
export class MemorySwap implements SwapAdapter {
  readonly name = 'memory'
  failNext = 0

  constructor(
    private readonly venue: MemoryVenue,
    private readonly chain: MemoryChainClient,
    private readonly owner: string,
    private readonly baseMint: string,
    private readonly quoteMint: string,
  ) {}

  async swapBaseToQuote(amountInRaw: bigint, maxSlippageBps: number): Promise<SwapResult> {
    if (amountInRaw <= 0n) return { signature: '', inRaw: 0n, outRaw: 0n }
    if (this.failNext > 0) {
      this.failNext--
      throw new Error('memory swap: failed (injected)')
    }
    const before = await this.venue.getPoolState()
    // constant-product quote before fees; the pool fee (≤ 3%) is allowed on top of the slippage cap
    const quoted = (before.quoteReserveRaw * amountInRaw) / (before.baseReserveRaw + amountInRaw)
    const minOut = (quoted * BigInt(10_000 - maxSlippageBps - 300)) / 10_000n
    const out = this.venue.trade('sell', amountInRaw)
    if (out < minOut) throw new Error(`memory swap: out ${out} below slippage-capped minimum ${minOut}`)
    this.chain.transferExternal(this.owner, MEMORY_POOL_ADDRESS, this.baseMint, amountInRaw)
    this.chain.credit(this.owner, this.quoteMint, out)
    return { signature: `mem-swap-${Date.now()}`, inRaw: amountInRaw, outRaw: out }
  }
}
