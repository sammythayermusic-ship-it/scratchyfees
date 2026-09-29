import {
  ComputeBudgetProgram,
  SendTransactionError,
  VersionedTransaction,
  type Connection,
  type Signer,
  type Transaction,
} from '@solana/web3.js'
import bs58 from 'bs58'

/**
 * Shared plumbing for the venue + swap adapters (PLAN §3 fee sweeper).
 *
 * sendAndConfirmSigned: fresh blockhash → sign (CREATOR) → send with preflight → poll
 * getSignatureStatuses until the requested commitment, rebroadcasting the identical bytes while the
 * blockhash is valid. It is deliberately NOT exactly-once (unlike the payout engine): every venue step
 * is re-measured from token balances by the sweeper, so a retry after an ambiguous outcome is safe.
 * Expiry is only declared once FINALIZED block height has passed lastValidBlockHeight and a full-history
 * status lookup still doesn't know the signature, so "expired" really means "can never land".
 *
 * Also holds the small guards both swap adapters share (slippage validation / minimum-out math) so the
 * Jupiter adapter never has to import the DAMM v2 SDK.
 */

export const DEFAULT_POLL_MS = 1_000
export const DEFAULT_RESEND_MS = 2_000
/** hard ceiling so a dead RPC can't hang the sweeper forever (blockhash life ≈ 60–90 s + finality lag) */
export const DEFAULT_SEND_TIMEOUT_MS = 180_000

export type VenueSendConnection = Pick<
  Connection,
  'getLatestBlockhash' | 'sendRawTransaction' | 'getSignatureStatuses' | 'getBlockHeight'
>

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
  /** slot the transaction landed in (use as minContextSlot for follow-up reads) */
  slot: number
}

export type VenueTxFailure = 'preflight' | 'onchain' | 'expired' | 'timeout'

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

/** sendAndConfirmSigned, also returning the slot the transaction landed in. */
export async function sendAndConfirmSignedWithSlot(
  connection: VenueSendConnection,
  tx: Transaction | VersionedTransaction,
  signers: Signer[],
  opts: SendOptions = {},
): Promise<ConfirmedTx> {
  const label = opts.label ?? 'venue tx'
  const commitment = opts.commitment ?? 'confirmed'
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const resendMs = opts.resendMs ?? DEFAULT_RESEND_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const { raw, signature } = signWithBlockhash(tx, signers, blockhash, opts.priorityFeeMicroLamports)
  const started = now()

  try {
    await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 0,
    })
  } catch (e) {
    if (e instanceof SendTransactionError) {
      // the RPC rejected it (preflight simulation / validation) — it was never forwarded
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

      const finalizedHeight = await connection.getBlockHeight('finalized')
      if (finalizedHeight > lastValidBlockHeight) {
        const hist = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
          .value[0]
        if (hist?.err) {
          throw new VenueTxError(
            `${label}: failed on-chain: ${renderErr(hist.err)} (${signature})`,
            'onchain',
            signature,
          )
        }
        if (!hist) {
          throw new VenueTxError(
            `${label}: blockhash expired without landing (${signature}); safe to rebuild and retry`,
            'expired',
            signature,
          )
        }
        if (reached(hist.confirmationStatus, commitment)) return { signature, slot: hist.slot }
        // landed in a block ≤ lastValidBlockHeight that hasn't reached the wanted commitment yet: keep polling
      }
    } catch (e) {
      if (e instanceof VenueTxError) throw e
      // transient RPC error: fall through to the timeout check and poll again
    }

    const t = now()
    if (t - started > timeoutMs) {
      throw new VenueTxError(
        `${label}: outcome unknown after ${timeoutMs}ms (${signature}); re-measure balances before retrying`,
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
