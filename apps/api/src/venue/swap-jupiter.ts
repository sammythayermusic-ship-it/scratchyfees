import { VersionedTransaction, type Connection, type Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { assertPositiveAmount, assertSlippageBps, minOutWithSlippage } from './send'
import type { SwapAdapter, SwapResult } from './types'

/**
 * SCRATCHY → PUMP through Jupiter Swap API v2 (PLAN §3 "swap the $SCRATCHY side to PUMP via Jupiter
 * (slippage-capped)"; mainnet path — under collectFeeMode OnlyB the sweeper normally uses NoSwap).
 *
 *   GET  {base}/swap/v2/order?inputMint&outputMint&amount&taker&slippageBps   (slippageBps ALWAYS explicit)
 *        → { transaction (base64 v0 tx; null/"" on error), requestId, inputMint, outputMint, inAmount,
 *            outAmount, otherAmountThreshold, errorCode, errorMessage, … }
 *   sign the VersionedTransaction as `taker`
 *   POST {base}/swap/v2/execute { signedTransaction, requestId }
 *        → { status: "Success" | "Failed", signature, code, error, totalInputAmount, totalOutputAmount }
 *
 * Nothing is signed unless the order is exactly what we asked for: same mints, same input amount,
 * ExactIn, a minimum-out no looser than our slippage cap, and a transaction that actually needs our
 * signature. in/out come from execute's totals; the signature is then confirmed on our own RPC.
 * The optional API key is sent only as the `x-api-key` header and never appears in errors.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export const JUPITER_ORDER_TIMEOUT_MS = 15_000
/** /execute waits for the swap to land */
export const JUPITER_EXECUTE_TIMEOUT_MS = 60_000

export interface JupiterSwapOptions {
  /** used only to confirm execute's signature on our own RPC */
  connection: Pick<Connection, 'getSignatureStatuses'>
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
}

export class JupiterSwapError extends Error {
  constructor(
    message: string,
    /** set once a transaction may have been submitted (execute reached) */
    readonly signature: string | null = null,
  ) {
    super(message)
    this.name = 'JupiterSwapError'
  }
}

const UINT_RE = /^\d+$/

function parseUint(v: unknown, field: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && UINT_RE.test(v)) return BigInt(v)
  throw new JupiterSwapError(`Jupiter: missing/invalid ${field} (${JSON.stringify(v)})`)
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
}

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
  return { requestId, tx, outAmount, otherAmountThreshold }
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

  async swapBaseToQuote(amountInRaw: bigint, maxSlippageBps: number): Promise<SwapResult> {
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

    v.tx.sign([this.o.owner])
    const takerIsFeePayer = v.tx.message.staticAccountKeys[0]?.toBase58() === taker
    const ourSig = takerIsFeePayer && v.tx.signatures[0] ? bs58.encode(v.tx.signatures[0]) : null
    const signedTransaction = Buffer.from(v.tx.serialize()).toString('base64')

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
    ).catch((e: unknown) => {
      // the signed tx may have been submitted: surface our signature so the sweeper can look it up
      if (e instanceof JupiterSwapError) throw new JupiterSwapError(e.message, ourSig)
      throw e
    })

    const signature = typeof exec.signature === 'string' && exec.signature !== '' ? exec.signature : null
    if (exec.status !== 'Success') {
      throw new JupiterSwapError(
        `Jupiter execute ${snippet(exec.status ?? null)}: code=${snippet(exec.code ?? null)} ` +
          `error=${snippet(exec.error ?? null)} signature=${signature ?? ourSig ?? 'none'}`,
        signature ?? ourSig,
      )
    }
    if (!signature) throw new JupiterSwapError('Jupiter execute reported Success without a signature', ourSig)
    if (ourSig && signature !== ourSig) {
      throw new JupiterSwapError(
        `Jupiter execute signature ${signature} ≠ the transaction we signed (${ourSig})`,
        ourSig,
      )
    }
    const inRaw = parseUint(exec.totalInputAmount ?? exec.inputAmountResult, 'totalInputAmount')
    const outRaw = parseUint(exec.totalOutputAmount ?? exec.outputAmountResult, 'totalOutputAmount')

    await this.confirmOnOurRpc(signature)
    return { signature, inRaw, outRaw }
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
      `Jupiter reported Success for ${signature} but our RPC hasn't confirmed it; re-measure balances`,
      signature,
    )
  }
}
