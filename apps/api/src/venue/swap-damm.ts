import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import type { Connection, Keypair, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { loadPoolStatics, type CpAmmLike, type PoolStatics } from './damm-v2'
import {
  assertPositiveAmount,
  assertSlippageBps,
  minOutWithSlippage,
  sendSignedAndConfirm,
  signWithFreshBlockhash,
  swapResultFromDeltas,
  txOwnerTokenDeltas,
  VenueTxError,
  type SendOptions,
  type TxDeltaOptions,
} from './send'
import type { OnSwapSigned, SwapAdapter, SwapResult } from './types'

/**
 * SCRATCHY → PUMP by swapping directly in the DAMM v2 pool (devnet's swap path; plan "Sweeper": the swap
 * step is exercised with a non-zero SCRATCHY delta on a BothToken devnet pool). Mainnet uses Jupiter.
 *
 * Quote with the SDK's getQuote (base → quote), then swap2 ExactIn with an explicit minimumAmountOut computed
 * by us from the quote's expected output: floor(out × (10000 − bps) / 10000) — the same formula as the SDK's
 * getAmountWithSlippage (cp-amm-sdk 1.5.0 takes `slippage` in BASIS POINTS, not percent), but we don't depend
 * on its rounding either way.
 *
 * SwapAdapter contract: sign → await onSigned → send → confirm. A throwing onSigned means nothing is sent.
 * From onSigned on, every throw is a VenueTxError carrying the signature (the swap may have landed).
 * The returned in/out come from the confirmed tx's OWN token-balance meta for the owner (in = −ΔSCRATCHY,
 * out = +ΔPUMP), and must match what we signed for: in == amountIn, out ≥ minimumAmountOut.
 */

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
  sendOptions?: Omit<SendOptions, 'label'>
  deltaOptions?: TxDeltaOptions
}

const LABEL = 'damm-v2 swap2'

export class DammPoolSwap implements SwapAdapter {
  readonly name = 'damm-v2-pool'
  private readonly cpAmm: CpAmmLike
  private statics: PoolStatics | null = null

  constructor(private readonly o: DammPoolSwapOptions) {
    if (o.baseMint.equals(o.quoteMint)) throw new Error('DammPoolSwap: base and quote mints must differ')
    this.cpAmm = o.cpAmm ?? new CpAmm(o.connection)
  }

  async swapBaseToQuote(
    amountInRaw: bigint,
    maxSlippageBps: number,
    onSigned?: OnSwapSigned,
  ): Promise<SwapResult> {
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
    if (minOut <= 0n) {
      throw new Error(
        `DammPoolSwap: minimum-out for ${amountInRaw} SCRATCHY rounds to 0 PUMP (quoted ${expectedOut}); refusing`,
      )
    }

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

    // 1. sign (nothing sent yet)
    const signed = await signWithFreshBlockhash(this.o.connection, tx, [this.o.owner], this.o.sendOptions)
    // 2. hand the signature to the caller; if it can't persist it, nothing is ever broadcast
    await onSigned?.({ signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight })

    // 3. send + confirm + book from the tx's own meta. Every throw from here on carries the signature.
    try {
      await sendSignedAndConfirm(this.o.connection, signed, { ...this.o.sendOptions, label: LABEL })
      const deltas = await txOwnerTokenDeltas(
        this.o.connection,
        signed.signature,
        this.o.owner.publicKey,
        this.o.deltaOptions,
      )
      return swapResultFromDeltas(signed.signature, deltas, {
        baseMint: this.o.baseMint.toBase58(),
        quoteMint: this.o.quoteMint.toBase58(),
        amountInRaw,
        minOutRaw: minOut,
      })
    } catch (e) {
      if (e instanceof VenueTxError && e.signature === signed.signature) throw e
      throw new VenueTxError(
        `${LABEL} ${signed.signature}: ${(e as Error).message ?? String(e)}; resolve the signature before retrying`,
        'measurement',
        signed.signature,
        e,
      )
    }
  }
}
