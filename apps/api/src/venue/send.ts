import {
  ComputeBudgetProgram,
  SendTransactionError,
  VersionedTransaction,
  type ConfirmedTransactionMeta,
  type Connection,
  type PublicKey,
  type Signer,
  type Transaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import type { SignedTx } from '../chain/types'
import type { SwapResult } from './types'

/**
 * Shared plumbing for the venue + swap adapters (PLAN §3 fee sweeper).
 *
 * Signing and sending are split so a swap can hand its signature to the sweeper BEFORE anything is
 * broadcast (SwapAdapter contract: sign → onSigned → send → confirm):
 *   signWithFreshBlockhash: fresh blockhash → sign → { signature, bytes, blockhash, lastValidBlockHeight }
 *   sendSignedAndConfirm:   send those exact bytes with preflight → poll getSignatureStatuses until the
 *                           requested commitment, rebroadcasting the IDENTICAL bytes (never a re-sign).
 * It is deliberately NOT exactly-once (unlike the payout engine): every venue step is booked from the
 * confirmed transaction's own token-balance meta (txOwnerTokenDeltas), never from before/after balance reads
 * (unpinned reads on a load-balanced RPC can double-count). Expiry is only declared once FINALIZED block
 * height has passed lastValidBlockHeight AND a full-history status lookup answered from a view at/after that
 * height's slot still doesn't know the signature, so "expired" really means "can never land".
 *
 * Also holds the small guards both swap adapters share (slippage validation / minimum-out math / booking a
 * swap from its tx deltas) so the Jupiter adapter never has to import the DAMM v2 SDK.
 */

export const DEFAULT_POLL_MS = 1_000
export const DEFAULT_RESEND_MS = 2_000
/** hard ceiling so a dead RPC can't hang the sweeper forever (blockhash life ≈ 60–90 s + finality lag) */
export const DEFAULT_SEND_TIMEOUT_MS = 180_000

export type VenueSignConnection = Pick<Connection, 'getLatestBlockhash'>
export type VenueSendConnection = Pick<
  Connection,
  'getLatestBlockhash' | 'sendRawTransaction' | 'getSignatureStatuses' | 'getEpochInfo'
>
export type TxMetaConnection = Pick<Connection, 'getTransaction'>

export interface SendOptions {
  /** name used in error messages (e.g. "damm-v2 claimPositionFee2") */
  label?: string
  /** commitment to wait for (default 'confirmed') */
  commitment?: 'confirmed' | 'finalized'
  pollMs?: number
  resendMs?: number
  timeoutMs?: number
  /** prepend a compute-unit price (legacy transactions without their own ComputeBudget ix only) */
  priorityFeeMicroLamports?: number
  /** injectable clock + sleep (tests) */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface ConfirmedTx {
  signature: string
  /** slot the transaction landed in */
  slot: number
}

/**
 * preflight   — the RPC rejected the bytes before forwarding them (they may still exist elsewhere: resolve)
 * onchain     — landed and failed
 * expired     — proven: can never land
 * timeout     — outcome unknown
 * measurement — confirmed (or possibly landed) but its effect could not be read / was not what we signed for
 */
export type VenueTxFailure = 'preflight' | 'onchain' | 'expired' | 'timeout' | 'measurement'

export class VenueTxError extends Error {
  constructor(
    message: string,
    readonly failure: VenueTxFailure,
    /** null when the transaction never got a signature (e.g. signing failed) */
    readonly signature: string | null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'VenueTxError'
  }
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

function renderErr(err: unknown): string {
  try {
    return typeof err === 'string' ? err : JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function reached(status: string | null | undefined, want: 'confirmed' | 'finalized'): boolean {
  if (want === 'finalized') return status === 'finalized'
  return status === 'confirmed' || status === 'finalized'
}

/** Set the blockhash, sign with `signers`, and return the wire bytes + first (fee payer) signature. */
export function signWithBlockhash(
  tx: Transaction | VersionedTransaction,
  signers: Signer[],
  blockhash: string,
  priorityFeeMicroLamports?: number,
): { raw: Uint8Array; signature: string } {
  if (signers.length === 0) throw new Error('signWithBlockhash: at least one signer is required')
  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = blockhash
    tx.sign(signers)
    const first = tx.signatures[0]
    if (!first || first.every((b) => b === 0)) {
      throw new Error('signWithBlockhash: fee payer signature missing (fee payer is not among the signers)')
    }
    return { raw: tx.serialize(), signature: bs58.encode(first) }
  }
  if (
    priorityFeeMicroLamports !== undefined &&
    priorityFeeMicroLamports > 0 &&
    !tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
  ) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    )
  }
  tx.recentBlockhash = blockhash
  if (!tx.feePayer) tx.feePayer = signers[0]!.publicKey
  tx.sign(...signers)
  const first = tx.signature
  if (!first) throw new Error('signWithBlockhash: fee payer signature missing')
  return { raw: tx.serialize(), signature: bs58.encode(first) }
}

/**
 * Fetch a fresh blockhash and sign. Nothing is sent: the caller can persist the signature (and the height
 * after which it provably can't land) before broadcasting the returned bytes with sendSignedAndConfirm.
 */
export async function signWithFreshBlockhash(
  connection: VenueSignConnection,
  tx: Transaction | VersionedTransaction,
  signers: Signer[],
  opts: Pick<SendOptions, 'priorityFeeMicroLamports'> = {},
): Promise<SignedTx> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const { raw, signature } = signWithBlockhash(tx, signers, blockhash, opts.priorityFeeMicroLamports)
  return { signature, bytes: raw, blockhash, lastValidBlockHeight }
}

/**
 * Broadcast already-signed bytes and wait for the requested commitment, rebroadcasting the identical bytes.
 * Throws VenueTxError (always carrying `signed.signature`) on RPC rejection, on-chain failure, proven expiry,
 * or timeout. A throw here does NOT prove the transaction didn't land except for failure 'expired'.
 */
export async function sendSignedAndConfirm(
  connection: Omit<VenueSendConnection, 'getLatestBlockhash'>,
  signed: Pick<SignedTx, 'signature' | 'bytes' | 'lastValidBlockHeight'>,
  opts: SendOptions = {},
): Promise<ConfirmedTx> {
  const label = opts.label ?? 'venue tx'
  const commitment = opts.commitment ?? 'confirmed'
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const resendMs = opts.resendMs ?? DEFAULT_RESEND_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const { signature, bytes: raw, lastValidBlockHeight } = signed
  const started = now()

  try {
    await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 0,
    })
  } catch (e) {
    if (e instanceof SendTransactionError) {
      // the RPC rejected it (preflight simulation / validation) — this node never forwarded it
      throw new VenueTxError(`${label}: rejected before landing: ${e.message}`, 'preflight', signature, e)
    }
    // transport trouble: the bytes may or may not have reached a leader — keep polling + rebroadcasting
  }
  let lastSend = now()

  for (;;) {
    await sleep(pollMs)
    try {
      const st = (await connection.getSignatureStatuses([signature])).value[0]
      if (st?.err) {
        throw new VenueTxError(
          `${label}: failed on-chain: ${renderErr(st.err)} (${signature})`,
          'onchain',
          signature,
        )
      }
      if (st && reached(st.confirmationStatus, commitment)) return { signature, slot: st.slot }

      // expiry proof: finalized height AND its slot from ONE response, then a full-history lookup answered
      // from a view at/after that slot (a lagging load-balanced node must not "prove" absence)
      const epoch = await connection.getEpochInfo('finalized')
      if (typeof epoch.blockHeight === 'number' && epoch.blockHeight > lastValidBlockHeight) {
        const hist = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
        const h = hist.value[0]
        if (h?.err) {
          throw new VenueTxError(
            `${label}: failed on-chain: ${renderErr(h.err)} (${signature})`,
            'onchain',
            signature,
          )
        }
        if (h && reached(h.confirmationStatus, commitment)) return { signature, slot: h.slot }
        if (!h && hist.context.slot >= epoch.absoluteSlot) {
          throw new VenueTxError(
            `${label}: blockhash expired without landing (${signature}); safe to rebuild and retry`,
            'expired',
            signature,
          )
        }
        // landed but not yet at the wanted commitment, or the history view lags the height view: keep polling
      }
    } catch (e) {
      if (e instanceof VenueTxError) throw e
      // transient RPC error: fall through to the timeout check and poll again
    }

    const t = now()
    if (t - started > timeoutMs) {
      throw new VenueTxError(
        `${label}: outcome unknown after ${timeoutMs}ms (${signature}); resolve the signature before retrying`,
        'timeout',
        signature,
      )
    }
    if (t - lastSend >= resendMs) {
      lastSend = t
      try {
        await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
      } catch {
        // rebroadcasts are best-effort ("already processed" etc. are expected)
      }
    }
  }
}

/** signWithFreshBlockhash + sendSignedAndConfirm, returning the signature and landing slot. */
export async function sendAndConfirmSignedWithSlot(
  connection: VenueSendConnection,
  tx: Transaction | VersionedTransaction,
  signers: Signer[],
  opts: SendOptions = {},
): Promise<ConfirmedTx> {
  const signed = await signWithFreshBlockhash(connection, tx, signers, opts)
  return sendSignedAndConfirm(connection, signed, opts)
}

/**
 * Sign `tx` with `signers` (the first is the fee payer unless the tx sets one), send it and wait until it
 * is confirmed. Returns the signature; throws VenueTxError on rejection, on-chain failure, proven expiry,
 * or timeout.
 */
export async function sendAndConfirmSigned(
  connection: VenueSendConnection,
  tx: Transaction | VersionedTransaction,
  signers: Signer[],
  opts: SendOptions = {},
): Promise<string> {
  return (await sendAndConfirmSignedWithSlot(connection, tx, signers, opts)).signature
}

// ── token deltas from the transaction's own meta ─────────────────────────────

type TokenBalanceMeta = Pick<ConfirmedTransactionMeta, 'preTokenBalances' | 'postTokenBalances'>

/**
 * mint → net raw change of `owner` across ALL its token accounts, from a transaction's pre/post token
 * balances (post − pre; an account created in the tx only has a post entry, a closed one only a pre entry).
 * Every entry must name its owner — an unattributable balance could hide one of ours, so it throws.
 */
export function ownerTokenDeltasFromMeta(meta: TokenBalanceMeta, owner: string): Map<string, bigint> {
  const deltas = new Map<string, bigint>()
  for (const [balances, sign] of [
    [meta.preTokenBalances ?? [], -1n],
    [meta.postTokenBalances ?? [], 1n],
  ] as const) {
    for (const b of balances) {
      if (!b.owner) {
        throw new Error(
          `token balance of account #${b.accountIndex} (mint ${b.mint}) has no owner in tx meta`,
        )
      }
      if (b.owner !== owner) continue
      const amount = b.uiTokenAmount?.amount
      if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
        throw new Error(
          `token balance of account #${b.accountIndex} has an invalid amount ${renderErr(amount)}`,
        )
      }
      deltas.set(b.mint, (deltas.get(b.mint) ?? 0n) + sign * BigInt(amount))
    }
  }
  return deltas
}

export interface TxDeltaOptions {
  /** getTransaction attempts while the (load-balanced) RPC doesn't know the confirmed tx yet (default 10) */
  attempts?: number
  retryMs?: number
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_TX_META_ATTEMPTS = 10
export const DEFAULT_TX_META_RETRY_MS = 1_000

/**
 * Exact token deltas of `owner` caused by the confirmed transaction `signature` (mint → raw), read from the
 * transaction's own pre/post token balances via getTransaction(confirmed, v0) — never from balance reads.
 * Retries while the RPC doesn't return the transaction yet; throws if it never does, if its meta is
 * missing, or if the transaction failed on-chain.
 */
export async function txOwnerTokenDeltas(
  connection: TxMetaConnection,
  signature: string,
  owner: PublicKey | string,
  opts: TxDeltaOptions = {},
): Promise<Map<string, bigint>> {
  const ownerStr = typeof owner === 'string' ? owner : owner.toBase58()
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_TX_META_ATTEMPTS)
  const retryMs = opts.retryMs ?? DEFAULT_TX_META_RETRY_MS
  const sleep = opts.sleep ?? defaultSleep
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(retryMs)
    let tx: Awaited<ReturnType<TxMetaConnection['getTransaction']>>
    try {
      tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
    } catch (e) {
      lastErr = e
      continue // transient RPC error
    }
    if (!tx) continue // this node hasn't caught up with the confirmation yet
    if (!tx.meta) throw new Error(`transaction ${signature} has no meta; cannot measure its token deltas`)
    if (tx.meta.err) {
      throw new Error(`transaction ${signature} failed on-chain: ${renderErr(tx.meta.err)}`)
    }
    return ownerTokenDeltasFromMeta(tx.meta, ownerStr)
  }
  throw new Error(
    `transaction ${signature} not returned by getTransaction after ${attempts} attempts` +
      (lastErr ? ` (last error: ${(lastErr as Error).message ?? renderErr(lastErr)})` : ''),
  )
}

// ── shared swap guards ───────────────────────────────────────────────────────

export const BPS_DENOMINATOR = 10_000n

/** Slippage must be an integer number of basis points in [0, 10000). */
export function assertSlippageBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw new RangeError(`maxSlippageBps must be an integer in [0, 10000), got ${bps}`)
  }
}

/** Minimum acceptable output for an exact-in swap: floor(expectedOut × (10000 − bps) / 10000). */
export function minOutWithSlippage(expectedOutRaw: bigint, maxSlippageBps: number): bigint {
  assertSlippageBps(maxSlippageBps)
  if (expectedOutRaw < 0n) throw new RangeError('expected output must be ≥ 0')
  return (expectedOutRaw * (BPS_DENOMINATOR - BigInt(maxSlippageBps))) / BPS_DENOMINATOR
}

export function assertPositiveAmount(amountInRaw: bigint, label: string): void {
  if (amountInRaw <= 0n) throw new RangeError(`${label}: amountIn must be > 0, got ${amountInRaw}`)
}

export interface SwapExpectation {
  /** SCRATCHY (sold) */
  baseMint: string
  /** PUMP (bought) */
  quoteMint: string
  /** exact-in amount we signed for */
  amountInRaw: bigint
  /** the minimum output the signed transaction enforces */
  minOutRaw: bigint
}

/**
 * Book a confirmed swap from the owner's own tx deltas: in = −Δbase, out = +Δquote. The swap must have
 * consumed exactly the amount we signed for and delivered at least the signed minimum; anything else throws
 * (the caller attaches the signature — the tx DID land, the sweeper resolves it from chain).
 */
export function swapResultFromDeltas(
  signature: string,
  deltas: Map<string, bigint>,
  want: SwapExpectation,
): SwapResult {
  const inRaw = -(deltas.get(want.baseMint) ?? 0n)
  const outRaw = deltas.get(want.quoteMint) ?? 0n
  if (inRaw !== want.amountInRaw) {
    throw new Error(`swap ${signature} spent ${inRaw} raw SCRATCHY, signed for exactly ${want.amountInRaw}`)
  }
  if (outRaw <= 0n || outRaw < want.minOutRaw) {
    throw new Error(
      `swap ${signature} delivered ${outRaw} raw PUMP, below the signed minimum ${want.minOutRaw}`,
    )
  }
  return { signature, inRaw, outRaw }
}
