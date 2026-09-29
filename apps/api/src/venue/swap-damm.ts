import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import type { Connection, Keypair, PublicKey, Signer, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import {
  loadPoolStatics,
  makeBaseQuoteReader,
  rpcBalanceReader,
  type BaseQuoteBalances,
  type CpAmmLike,
  type PoolStatics,
  type TokenBalanceReader,
} from './damm-v2'
import {
  assertPositiveAmount,
  assertSlippageBps,
  minOutWithSlippage,
  sendAndConfirmSignedWithSlot,
  type ConfirmedTx,
} from './send'
import type { SwapAdapter, SwapResult } from './types'

/**
 * SCRATCHY → PUMP by swapping directly in the DAMM v2 pool (devnet's swap path; plan "Sweeper": the swap
 * step is exercised with a non-zero SCRATCHY delta on a BothToken devnet pool). Mainnet uses Jupiter.
 *
 * Quote with the SDK's getQuote (base → quote), then swap2 ExactIn. The minimum-out is computed by us from
 * the quote's expected output: floor(out × (10000 − bps) / 10000). (cp-amm-sdk 1.5.0 takes `slippage` in
 * BASIS POINTS — not percent — so we pass bps and don't depend on its rounding either way.)
 * The returned in/out are the owner's measured balance deltas around the confirmed swap.
 */

export interface MeasuredSwapSteps {
  readBalances(minContextSlot?: number): Promise<BaseQuoteBalances>
  send(): Promise<ConfirmedTx>
}

/** before → swap → after (pinned to the landing slot); in = SCRATCHY spent, out = PUMP received. */
export async function runMeasuredSwap(steps: MeasuredSwapSteps): Promise<SwapResult> {
  const before = await steps.readBalances()
  const tx = await steps.send()
  const after = await steps.readBalances(tx.slot)
  if (after.base.slot < tx.slot || after.quote.slot < tx.slot) {
    throw new Error(`swap ${tx.signature} landed at slot ${tx.slot} but the balance view is older; re-measure`)
  }
  const inRaw = before.base.value - after.base.value
  const outRaw = after.quote.value - before.quote.value
  if (inRaw < 0n || outRaw < 0n) {
    throw new Error(
      `swap ${tx.signature}: inconsistent balance deltas (SCRATCHY spent ${inRaw}, PUMP received ${outRaw}) — ` +
        `concurrent transfer? re-measure`,
    )
  }
  return { signature: tx.signature, inRaw, outRaw }
}

export interface DammPoolSwapOptions {
  connection: Connection
  /** the wallet holding the SCRATCHY to sell (CREATOR); signs + pays */
  owner: Keypair
  pool: PublicKey
  /** SCRATCHY */
  baseMint: PublicKey
  /** PUMP */
  quoteMint: PublicKey
  /** test seams */
  cpAmm?: CpAmmLike
  balanceReader?: TokenBalanceReader
  send?: (tx: Transaction, signers: Signer[]) => Promise<ConfirmedTx>
}

export class DammPoolSwap implements SwapAdapter {
  readonly name = 'damm-v2-pool'
  private readonly cpAmm: CpAmmLike
  private readonly readBalances: (minContextSlot?: number) => Promise<BaseQuoteBalances>
  private readonly send: (tx: Transaction, signers: Signer[]) => Promise<ConfirmedTx>
  private statics: PoolStatics | null = null

  constructor(private readonly o: DammPoolSwapOptions) {
    if (o.baseMint.equals(o.quoteMint)) throw new Error('DammPoolSwap: base and quote mints must differ')
    this.cpAmm = o.cpAmm ?? new CpAmm(o.connection)
    this.readBalances = makeBaseQuoteReader(
      o.balanceReader ?? rpcBalanceReader(o.connection),
      o.owner.publicKey,
      o.baseMint,
      o.quoteMint,
    )
    this.send =
      o.send ?? ((tx, signers) => sendAndConfirmSignedWithSlot(o.connection, tx, signers, { label: 'damm-v2 swap2' }))
  }

  async swapBaseToQuote(amountInRaw: bigint, maxSlippageBps: number): Promise<SwapResult> {
    assertPositiveAmount(amountInRaw, 'DammPoolSwap')
    assertSlippageBps(maxSlippageBps)
    if (!this.statics) {
      this.statics = (
        await loadPoolStatics(this.o.connection, this.cpAmm, this.o.pool, this.o.baseMint, this.o.quoteMint)
      ).statics
    }
    const s = this.statics
    const poolState = await this.cpAmm.fetchPoolState(this.o.pool)
    if (!poolState.tokenAMint.equals(s.tokenAMint) || !poolState.tokenBMint.equals(s.tokenBMint)) {
      throw new Error(`DAMM v2 pool ${this.o.pool.toBase58()} mints changed — refusing to swap`)
    }

    const currentSlot = await this.o.connection.getSlot('confirmed')
    const blockTime = await this.o.connection.getBlockTime(currentSlot).catch(() => null)
    const currentTime = blockTime ?? Math.floor(Date.now() / 1000)
    const amountIn = new BN(amountInRaw.toString())
    const quote = this.cpAmm.getQuote({
      inAmount: amountIn,
      inputTokenMint: this.o.baseMint,
      slippage: maxSlippageBps,
      poolState,
      currentTime,
      currentSlot,
      tokenADecimal: s.decA,
      tokenBDecimal: s.decB,
    })
    const expectedOut = BigInt(quote.swapOutAmount.toString())
    if (expectedOut <= 0n) {
      throw new Error(`DammPoolSwap: quote for ${amountInRaw} SCRATCHY returns no PUMP (pool too shallow?)`)
    }
    const minOut = minOutWithSlippage(expectedOut, maxSlippageBps)

    return runMeasuredSwap({
      readBalances: (minSlot) => this.readBalances(minSlot),
      send: async () => {
        const tx = await this.cpAmm.swap2({
          payer: this.o.owner.publicKey,
          pool: this.o.pool,
          inputTokenMint: this.o.baseMint,
          outputTokenMint: this.o.quoteMint,
          tokenAMint: s.tokenAMint,
          tokenBMint: s.tokenBMint,
          tokenAVault: s.tokenAVault,
          tokenBVault: s.tokenBVault,
          tokenAProgram: s.tokenAProgram,
          tokenBProgram: s.tokenBProgram,
          referralTokenAccount: null,
          poolState,
          swapMode: SwapMode.ExactIn,
          amountIn,
          minimumAmountOut: new BN(minOut.toString()),
        })
        return this.send(tx, [this.o.owner])
      },
    })
  }
}
