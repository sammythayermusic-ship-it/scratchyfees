import { VersionedTransaction, type Connection, type Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  assertPositiveAmount,
  assertSlippageBps,
  minOutWithSlippage,
  swapResultFromDeltas,
  txOwnerTokenDeltas,
  type TxDeltaOptions,
} from './send'
import type { OnSwapSigned, SwapAdapter, SwapResult } from './types'

/**
 * SCRATCHY → PUMP through Jupiter Swap API v2 (PLAN §3 "swap the $SCRATCHY side to PUMP via Jupiter
 * (slippage-capped)"; mainnet path — under collectFeeMode OnlyB the sweeper normally uses NoSwap).
 *
 *   GET  {base}/swap/v2/order?inputMint&outputMint&amount&taker&slippageBps   (slippageBps ALWAYS explicit)
 *        → { transaction (base64 v0 tx; null/"" on error), requestId, inputMint, outputMint, inAmount,
 *            outAmount, otherAmountThreshold, errorCode, errorMessage, … }
 *   sign the VersionedTransaction as `taker` → onSigned(signature) → only then:
 *   POST {base}/swap/v2/execute { signedTransaction, requestId }
 *        → { status: "Success" | "Failed", signature, code, error, … }
 *
 * Nothing is signed unless the order is exactly what we asked for: same mints, same input amount,
 * ExactIn, a minimum-out no looser than our slippage cap, a transaction that needs our signature AND whose
 * fee payer is the taker (gasless / Jupiter-paid orders are refused: with the taker as fee payer OUR
 * signature is the transaction id, so the sweeper can persist and later resolve it before anything is sent).
 * After /execute the signature is confirmed on our own RPC and in/out are booked from the confirmed tx's own
 * token-balance meta (never from execute's totals or balance reads). Every throw after onSigned is a
 * JupiterSwapError carrying our signature: the swap may have landed.
 * The optional API key is sent only as the `x-api-key` header and never appears in errors.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export const JUPITER_ORDER_TIMEOUT_MS = 15_000
/** /execute waits for the swap to land */
export const JUPITER_EXECUTE_TIMEOUT_MS = 60_000

/**
 * Our RPC may lag Jupiter's by a few blocks, so a lastValidBlockHeight derived from OUR latest blockhash gets
 * this margin; an over-estimate only delays the sweeper's expiry proof, an under-estimate could fake one.
 */
export const JUPITER_EXPIRY_MARGIN_BLOCKS = 32

export interface JupiterSwapOptions {
  /** our own RPC: expiry height for onSigned, confirmation of the signature, and the tx meta to book from */
  connection: Pick<Connection, 'getSignatureStatuses' | 'getLatestBlockhash' | 'getTransaction'>
  /** taker (CREATOR): holds the SCRATCHY and signs */
  owner: Keypair
  /** API origin, e.g. https://api.jup.ag (JUPITER_API_BASE) */
  base: string
  apiKey?: string
  fetchImpl?: FetchFn
  /** SCRATCHY */
  inputMint: string
  /** PUMP */
  outputMint: string
  orderTimeoutMs?: number
  executeTimeoutMs?: number
  /** confirmation polls on our RPC after a Success (default 15 × 1 s) */
  confirmPolls?: number
  confirmPollMs?: number
  sleep?: (ms: number) => Promise<void>
  /** getTransaction retries while booking from the tx meta */
  deltaOptions?: TxDeltaOptions
}

export class JupiterSwapError extends Error {
  constructor(
    message: string,
    /** always set once the transaction is signed and handed to onSigned (it may have been submitted) */
    readonly signature: string | null = null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'JupiterSwapError'
  }
}

const UINT_RE = /^\d+$/

function parseUint(v: unknown, field: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && UINT_RE.test(v)) return BigInt(v)
  throw new JupiterSwapError(`Jupiter: missing/invalid ${field} (${JSON.stringify(v)})`)
}

/** lenient: a positive integer (number or decimal string) or null */
function optionalHeight(v: unknown): number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v
  if (typeof v === 'string' && UINT_RE.test(v)) {
    const n = Number(v)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return null
}

function snippet(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

async function requestJson(
  fetchImpl: FetchFn,
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: Response
    let text: string
    try {
      res = await fetchImpl(url, { ...init, signal: ctrl.signal })
      text = await res.text()
    } catch (e) {
      if (ctrl.signal.aborted) throw new JupiterSwapError(`${label}: timed out after ${timeoutMs}ms`)
      throw new JupiterSwapError(`${label}: request failed: ${(e as Error).message}`)
    }
    let body: unknown = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }
    if (!res.ok) {
      const detail =
        body && typeof body === 'object'
          ? ((body as Record<string, unknown>).error ??
            (body as Record<string, unknown>).errorMessage ??
            body)
          : text
      throw new JupiterSwapError(`${label}: HTTP ${res.status}: ${snippet(detail)}`)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new JupiterSwapError(`${label}: malformed response body`)
    }
    return body as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

export interface OrderExpectation {
  inputMint: string
  outputMint: string
  amountInRaw: bigint
  maxSlippageBps: number
  taker: string
}

export interface ValidatedOrder {
  requestId: string
  tx: VersionedTransaction
  outAmount: bigint
  otherAmountThreshold: bigint
  /** the order's own lastValidBlockHeight, when it reports one */
  lastValidBlockHeight: number | null
}

/** order fields that name who pays the transaction fee (any of them ≠ taker = gasless / sponsored) */
const FEE_PAYER_FIELDS = ['feePayer', 'signatureFeePayer', 'prioritizationFeePayer'] as const

/** Refuse anything that isn't exactly the order we asked for (pure; exported for tests). */
export function validateOrder(order: Record<string, unknown>, want: OrderExpectation): ValidatedOrder {
  const { errorCode, errorMessage, error } = order
  if ((errorCode !== undefined && errorCode !== null && errorCode !== 0 && errorCode !== '') || error) {
    throw new JupiterSwapError(
      `Jupiter order refused: errorCode=${snippet(errorCode ?? null)} ` +
        `errorMessage=${snippet(errorMessage ?? error ?? null)}`,
    )
  }
  const txB64 = order.transaction
  if (typeof txB64 !== 'string' || txB64 === '') {
    throw new JupiterSwapError(
      `Jupiter order has no transaction (errorMessage=${snippet(errorMessage ?? null)}); nothing to sign`,
    )
  }
  const requestId = order.requestId
  if (typeof requestId !== 'string' || requestId === '')
    throw new JupiterSwapError('Jupiter order has no requestId')
  if (order.inputMint !== want.inputMint || order.outputMint !== want.outputMint) {
    throw new JupiterSwapError(
      `Jupiter order mints mismatch: got ${snippet(order.inputMint ?? null)} → ${snippet(order.outputMint ?? null)}, ` +
        `asked ${want.inputMint} → ${want.outputMint}`,
    )
  }
  const inAmount = parseUint(order.inAmount, 'inAmount')
  if (inAmount !== want.amountInRaw) {
    throw new JupiterSwapError(`Jupiter order inAmount ${inAmount} ≠ requested ${want.amountInRaw}`)
  }
  if (order.swapMode !== undefined && order.swapMode !== 'ExactIn') {
    throw new JupiterSwapError(`Jupiter order swapMode ${snippet(order.swapMode)} ≠ ExactIn`)
  }
  if (order.slippageBps !== undefined && order.slippageBps !== null) {
    const bps = Number(order.slippageBps)
    if (!Number.isFinite(bps) || bps > want.maxSlippageBps) {
      throw new JupiterSwapError(
        `Jupiter order slippageBps ${snippet(order.slippageBps)} > cap ${want.maxSlippageBps}`,
      )
    }
  }
  const outAmount = parseUint(order.outAmount, 'outAmount')
  const otherAmountThreshold = parseUint(order.otherAmountThreshold, 'otherAmountThreshold')
  if (outAmount <= 0n || otherAmountThreshold <= 0n) {
    throw new JupiterSwapError(
      `Jupiter order returns no output (out ${outAmount}, min ${otherAmountThreshold})`,
    )
  }
  const floor = minOutWithSlippage(outAmount, want.maxSlippageBps)
  if (otherAmountThreshold < floor) {
    throw new JupiterSwapError(
      `Jupiter order minimum-out ${otherAmountThreshold} is looser than the ${want.maxSlippageBps} bps cap ` +
        `(needs ≥ ${floor} for quoted ${outAmount})`,
    )
  }
  let tx: VersionedTransaction
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'))
  } catch (e) {
    throw new JupiterSwapError(`Jupiter order transaction does not deserialize: ${(e as Error).message}`)
  }
  const signers = tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((k) => k.toBase58())
  if (!signers.includes(want.taker)) {
    throw new JupiterSwapError(
      `Jupiter order transaction does not require the taker ${want.taker} as a signer`,
    )
  }
  // gasless / sponsored orders: someone else's signature would be the tx id, so ours couldn't be persisted
  // and resolved before submission — refuse them
  if (order.gasless === true || order.gasless === 'true') {
    throw new JupiterSwapError('Jupiter order is gasless (fee payer is not the taker); refusing to sign')
  }
  if (signers[0] !== want.taker) {
    throw new JupiterSwapError(
      `Jupiter order transaction fee payer ${signers[0] ?? 'none'} is not the taker ${want.taker} ` +
        `(gasless / sponsored order); refusing to sign`,
    )
  }
  for (const f of FEE_PAYER_FIELDS) {
    const v = order[f]
    if (typeof v === 'string' && v !== '' && v !== want.taker) {
      throw new JupiterSwapError(
        `Jupiter order ${f} ${snippet(v)} is not the taker ${want.taker}; refusing to sign`,
      )
    }
  }
  return {
    requestId,
    tx,
    outAmount,
    otherAmountThreshold,
    lastValidBlockHeight: optionalHeight(order.lastValidBlockHeight),
  }
}

export class JupiterSwap implements SwapAdapter {
  readonly name = 'jupiter'
  private readonly base: string
  private readonly fetchImpl: FetchFn
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly o: JupiterSwapOptions) {
    if (o.inputMint === o.outputMint) throw new Error('JupiterSwap: input and output mints must differ')
    this.base = o.base.replace(/\/+$/, '')
    this.fetchImpl = o.fetchImpl ?? ((url, init) => fetch(url, init))
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...extra }
    if (this.o.apiKey) h['x-api-key'] = this.o.apiKey
    return h
  }

  orderUrl(amountInRaw: bigint, maxSlippageBps: number): string {
    const q = new URLSearchParams({
      inputMint: this.o.inputMint,
      outputMint: this.o.outputMint,
      amount: amountInRaw.toString(),
      taker: this.o.owner.publicKey.toBase58(),
      slippageBps: String(maxSlippageBps),
    })
    return `${this.base}/swap/v2/order?${q.toString()}`
  }

  async swapBaseToQuote(
    amountInRaw: bigint,
    maxSlippageBps: number,
    onSigned?: OnSwapSigned,
  ): Promise<SwapResult> {
    assertPositiveAmount(amountInRaw, 'JupiterSwap')
    assertSlippageBps(maxSlippageBps)
    const taker = this.o.owner.publicKey.toBase58()

    const order = await requestJson(
      this.fetchImpl,
      this.orderUrl(amountInRaw, maxSlippageBps),
      { method: 'GET', headers: this.headers() },
      'Jupiter /swap/v2/order',
      this.o.orderTimeoutMs ?? JUPITER_ORDER_TIMEOUT_MS,
    )
    const v = validateOrder(order, {
      inputMint: this.o.inputMint,
      outputMint: this.o.outputMint,
      amountInRaw,
      maxSlippageBps,
      taker,
    })

    // 1. sign (the taker is the fee payer, so its signature IS the transaction id)
    v.tx.sign([this.o.owner])
    const first = v.tx.signatures[0]
    if (!first || first.every((b) => b === 0)) {
      throw new JupiterSwapError('Jupiter order transaction has no taker signature after signing')
    }
    const signature = bs58.encode(first)
    const signedTransaction = Buffer.from(v.tx.serialize()).toString('base64')
    const lastValidBlockHeight = await this.expiryHeight(v)

    // 2. hand the signature to the caller; if it can't persist it, nothing is ever submitted
    await onSigned?.({ signature, lastValidBlockHeight })

    // 3. execute → confirm on our RPC → book from the tx's own meta. Every throw from here on carries it.
    try {
      return await this.executeAndBook(v, signature, signedTransaction, amountInRaw)
    } catch (e) {
      if (e instanceof JupiterSwapError && e.signature === signature) throw e
      throw new JupiterSwapError(
        `Jupiter swap ${signature}: ${(e as Error).message ?? String(e)}; resolve the signature before retrying`,
        signature,
        e,
      )
    }
  }

  /**
   * Upper bound on the block height after which the signed transaction can never land: the order's own
   * value when reported, and our RPC's latest-blockhash height + margin (the order's blockhash is no newer).
   */
  private async expiryHeight(v: ValidatedOrder): Promise<number> {
    let ours: number | null = null
    try {
      ours = (await this.o.connection.getLatestBlockhash('confirmed')).lastValidBlockHeight
    } catch {
      ours = null
    }
    if (ours === null && v.lastValidBlockHeight === null) {
      throw new JupiterSwapError(
        'Jupiter: cannot determine the lastValidBlockHeight of the order transaction (RPC unavailable); not submitting',
      )
    }
    return Math.max(ours === null ? 0 : ours + JUPITER_EXPIRY_MARGIN_BLOCKS, v.lastValidBlockHeight ?? 0)
  }

  private async executeAndBook(
    v: ValidatedOrder,
    signature: string,
    signedTransaction: string,
    amountInRaw: bigint,
  ): Promise<SwapResult> {
    const exec = await requestJson(
      this.fetchImpl,
      `${this.base}/swap/v2/execute`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ signedTransaction, requestId: v.requestId }),
      },
      'Jupiter /swap/v2/execute',
      this.o.executeTimeoutMs ?? JUPITER_EXECUTE_TIMEOUT_MS,
    )

    const execSig = typeof exec.signature === 'string' && exec.signature !== '' ? exec.signature : null
    if (execSig && execSig !== signature) {
      throw new JupiterSwapError(
        `Jupiter execute signature ${execSig} ≠ the transaction we signed (${signature})`,
        signature,
      )
    }
    if (exec.status !== 'Success') {
      throw new JupiterSwapError(
        `Jupiter execute ${snippet(exec.status ?? null)}: code=${snippet(exec.code ?? null)} ` +
          `error=${snippet(exec.error ?? null)} signature=${signature}`,
        signature,
      )
    }

    await this.confirmOnOurRpc(signature)
    const deltas = await txOwnerTokenDeltas(
      this.o.connection,
      signature,
      this.o.owner.publicKey,
      this.o.deltaOptions,
    )
    return swapResultFromDeltas(signature, deltas, {
      baseMint: this.o.inputMint,
      quoteMint: this.o.outputMint,
      amountInRaw,
      minOutRaw: v.otherAmountThreshold,
    })
  }

  /** Don't take the API's word for it: the signature must be confirmed (and error-free) on our RPC. */
  private async confirmOnOurRpc(signature: string): Promise<void> {
    const polls = this.o.confirmPolls ?? 15
    const pollMs = this.o.confirmPollMs ?? 1_000
    for (let i = 0; i < polls; i++) {
      try {
        const st = (
          await this.o.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
        ).value[0]
        if (st?.err) {
          throw new JupiterSwapError(
            `Jupiter swap ${signature} failed on-chain: ${snippet(st.err)}`,
            signature,
          )
        }
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return
      } catch (e) {
        if (e instanceof JupiterSwapError) throw e
        // transient RPC error: poll again
      }
      if (i < polls - 1) await this.sleep(pollMs)
    }
    throw new JupiterSwapError(
      `Jupiter reported Success for ${signature} but our RPC hasn't confirmed it; resolve the signature before retrying`,
      signature,
    )
  }
}
