/**
 * Chain abstraction. Two implementations:
 *  - SolanaChainClient  (devnet / localnet / mainnet-beta via RPC, @solana/web3.js v1 + spl-token)
 *  - MemoryChainClient  (in-process ledger with fault injection — tests, local dev, load tests)
 * Everything above this layer (payouts, sweeper, engine) only talks to this interface.
 * All token amounts are raw base-unit bigints; SOL amounts are lamports (bigint).
 */

export type Commitment = 'processed' | 'confirmed' | 'finalized'
export type ClusterName = 'devnet' | 'localnet' | 'mainnet-beta' | 'memory'

export interface MintInfo {
  address: string
  decimals: number
  /** SPL Token or Token-2022 program id (base58) */
  tokenProgram: string
  isToken2022: boolean
  supply: bigint
  /** Token-2022 extensions present on the mint (names as in spl-token ExtensionType) */
  extensions: string[]
  /** transferHook program id if a hook is configured (null = unset even if the extension exists) */
  transferHookProgram: string | null
  /** extensions that change transfer semantics and must refuse boot (TransferFee, PermanentDelegate, …) */
  blockingExtensions: string[]
}

export interface BalanceAt<T = bigint> {
  value: T
  /** context slot the value was read at */
  slot: number
}

export interface SignedTx {
  /** base58 transaction signature (first signature) */
  signature: string
  /** serialized, fully signed transaction */
  bytes: Uint8Array
  blockhash: string
  lastValidBlockHeight: number
}

export interface SimulationResult {
  ok: boolean
  /** program/transaction error rendered as a string, if any */
  error: string | null
  /** true when the error is deterministic and retrying can never succeed */
  permanent: boolean
  logs: string[]
  unitsConsumed: number | null
}

export interface SignatureStatus {
  slot: number
  confirmationStatus: Commitment | null
  /** null = succeeded; otherwise the on-chain error */
  err: string | null
}

export interface SignatureStatuses {
  /** slot of the RPC node's view when it answered (for "absent at slot ≥ X" proofs) */
  contextSlot: number
  statuses: (SignatureStatus | null)[]
}

/** Which server-held key signs: PRIZE (hot, payouts) or CREATOR (fee claims + 70/30 split). */
export type SignerRole = 'prize' | 'creator'

export interface TransferTxRequest {
  signer: SignerRole
  recipient: string
  mint: string
  amountRaw: bigint
  /** memo written first in the tx (payouts: `scratchy:<deployId>:<payoutId>`) — also makes each tx unique */
  memo: string
  priorityFeeMicroLamports: number
}

export interface BuiltTransferTx extends SignedTx {
  /** whether this tx includes an idempotent ATA creation for a currently-missing account */
  createsAta: boolean
}

export function payoutMemo(deployId: string, payoutId: bigint | string): string {
  return `scratchy:${deployId}:${payoutId.toString()}`
}

/** A parsed on-chain payout, for the rehearsal's verify-every-payout pass. */
export interface ParsedPayoutTx {
  signature: string
  slot: number
  err: string | null
  memo: string | null
  /** net token change of the recipient owner for the payout mint (raw) */
  recipientDeltaRaw: bigint
  /** net token change of the sender owner for the payout mint (raw, negative for a payout) */
  senderDeltaRaw: bigint
  recipientOwner: string | null
}

export interface ChainClient {
  readonly cluster: ClusterName
  /** verify we are connected to the expected cluster (genesis hash); throws otherwise */
  verifyCluster(): Promise<void>

  getSlot(commitment?: Commitment): Promise<number>
  /**
   * Block height and the slot it was observed at, from ONE response (getEpochInfo). Used for expiry
   * proofs: an attempt is dead once finalized height > its lastValidBlockHeight AND a later
   * getSignatureStatuses (contextSlot ≥ this slot, full history) still doesn't know its signature.
   */
  getHeightAndSlot(commitment?: Commitment): Promise<{ blockHeight: number; slot: number }>
  getSolBalance(owner: string, commitment?: Commitment): Promise<BalanceAt>
  getMintInfo(mint: string): Promise<MintInfo>
  /** total balance of `owner` for `mint` across all its token accounts */
  getTokenBalance(owner: string, mint: string, commitment?: Commitment): Promise<BalanceAt>
  /** batched holdings for many owners (ATA batch read + per-owner fallback) */
  getHoldings(owners: string[], mint: string): Promise<BalanceAt<Map<string, bigint>>>
  /** does the owner's associated token account for `mint` exist */
  ataExists(owner: string, mint: string): Promise<boolean>

  /** token transfer: compute budget + memo + idempotent ATA create (payer = signer) + hook-aware transferChecked */
  buildTransferTx(req: TransferTxRequest): Promise<BuiltTransferTx>
  simulate(bytes: Uint8Array): Promise<SimulationResult>
  sendRaw(bytes: Uint8Array): Promise<string>
  getSignatureStatuses(signatures: string[]): Promise<SignatureStatuses>
  /** estimate a compute-unit price (µ-lamports) for a payout tx, capped by the caller */
  estimatePriorityFee(): Promise<number>

  getPayoutTx(signature: string, mint: string, senderOwner: string): Promise<ParsedPayoutTx | null>

  /** addresses of the server-held signers (CREATOR may be null when the sweeper is disabled) */
  readonly prizeAddress: string
  readonly creatorAddress: string | null
}

/** Thrown by clients for transient RPC trouble (timeouts, 429s) — callers retry, never mark permanent. */
export class TransientChainError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'TransientChainError'
  }
}
