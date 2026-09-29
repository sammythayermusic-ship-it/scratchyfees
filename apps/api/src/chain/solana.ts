import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TokenError,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
  type Keypair,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { verifyCluster, type SolanaClusterName } from './cluster'
import { inspectMint } from './mint'
import {
  TransientChainError,
  type BalanceAt,
  type BuiltTransferTx,
  type ChainClient,
  type Commitment,
  type MintInfo,
  type ParsedPayoutTx,
  type SignatureStatus,
  type SignatureStatuses,
  type SignerRole,
  type SimulationResult,
  type TransferTxRequest,
} from './types'

/**
 * ChainClient over a real Solana RPC (devnet / localnet / mainnet-beta) with @solana/web3.js v1 +
 * spl-token. PLAN §5 payout transactions are built here:
 *
 *   [0] ComputeBudget.setComputeUnitLimit   [1] ComputeBudget.setComputeUnitPrice
 *   [2] ATA.createIdempotent(payer = signer) — the recipient's ATA for the mint's program; always
 *       included (a no-op if it exists), so a tx built while the ATA exists still lands if it is closed
 *   [3] Memo `scratchy:<deployId>:<payoutId>` (signed by the sender) — IMMEDIATELY before the transfer,
 *       where Token-2022's required-memo (MemoTransfer) extension looks for it
 *   [4] transferChecked from the signer's ATA, with transfer-hook extra accounts resolved when the mint
 *       has a hook program (the real PUMP mint carries the extension with the program unset)
 *
 * The message is v0, signed with the role's keypair; ed25519 signatures are deterministic, so identical
 * inputs + blockhash give identical bytes and signature — the payout worker's resend-identical-bytes
 * protocol relies on this. RPC trouble surfaces as TransientChainError (callers retry, never mark a
 * payout permanent); only caller errors (invalid params) and decoding bugs throw plain Errors.
 */

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const DEFAULT_COMPUTE_UNIT_LIMIT = 120_000
export const MIN_PRIORITY_FEE_MICROLAMPORTS = 1_000
export const DEFAULT_FALLBACK_PRIORITY_FEE_MICROLAMPORTS = 20_000
export const SIGNATURE_STATUS_CHUNK = 256
export const MULTIPLE_ACCOUNTS_CHUNK = 100
export const HOLDINGS_FALLBACK_CONCURRENCY = 4
export const HELIUS_TIMEOUT_MS = 3_000
/** SPL Token / Token-2022 account layout: mint (0..32), owner (32..64), amount u64 LE (64..72) */
export const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64

const U64_MAX = (1n << 64n) - 1n

/** The subset of `fetch` used for the Helius fee estimate (injected so tests never touch the network). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface SolanaChainClientOptions {
  connection: Connection
  cluster: SolanaClusterName
  prize: Keypair
  creator: Keypair | null
  computeUnitLimit?: number
  /** priority fee returned when no estimate can be obtained at all (µ-lamports; the caller still caps) */
  fallbackPriorityFeeMicroLamports?: number
  fetch?: FetchFn
}

interface MintMeta {
  programId: PublicKey
  decimals: number
}

export class SolanaChainClient implements ChainClient {
  readonly cluster: SolanaClusterName
  readonly prizeAddress: string
  readonly creatorAddress: string | null

  private readonly connection: Connection
  private readonly prize: Keypair
  private readonly creator: Keypair | null
  private readonly computeUnitLimit: number
  private readonly fallbackPriorityFee: number
  private readonly fetchImpl: FetchFn
  /** decimals + owning program never change for a mint, so they are cached for the process lifetime */
  private readonly mintMetaCache = new Map<string, MintMeta>()

  constructor(opts: SolanaChainClientOptions) {
    this.connection = opts.connection
    this.cluster = opts.cluster
    this.prize = opts.prize
    this.creator = opts.creator
    this.prizeAddress = opts.prize.publicKey.toBase58()
    this.creatorAddress = opts.creator ? opts.creator.publicKey.toBase58() : null
    this.computeUnitLimit = opts.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT
    this.fallbackPriorityFee =
      opts.fallbackPriorityFeeMicroLamports ?? DEFAULT_FALLBACK_PRIORITY_FEE_MICROLAMPORTS
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init))
    if (
      !Number.isInteger(this.computeUnitLimit) ||
      this.computeUnitLimit <= 0 ||
      this.computeUnitLimit > 1_400_000
    ) {
      throw new Error(`computeUnitLimit must be an integer in 1..1,400,000 (got ${this.computeUnitLimit})`)
    }
  }

  // ── cluster / slots ────────────────────────────────────────────────────────
  async verifyCluster(): Promise<void> {
    await verifyCluster(this.connection, this.cluster)
  }

  async getSlot(commitment: Commitment = 'confirmed'): Promise<number> {
    return this.rpc('getSlot', () => this.connection.getSlot(commitment))
  }

  async getHeightAndSlot(
    commitment: Commitment = 'confirmed',
  ): Promise<{ blockHeight: number; slot: number }> {
    const info = await this.rpc('getEpochInfo', () => this.connection.getEpochInfo(commitment))
    if (typeof info.blockHeight !== 'number') {
      throw new TransientChainError('getEpochInfo: the RPC did not report a block height')
    }
    return { blockHeight: info.blockHeight, slot: info.absoluteSlot }
  }

  // ── balances ───────────────────────────────────────────────────────────────
  async getSolBalance(owner: string, commitment: Commitment = 'confirmed'): Promise<BalanceAt> {
    const pk = new PublicKey(owner)
    const r = await this.rpc('getBalance', () => this.connection.getBalanceAndContext(pk, commitment))
    return { value: BigInt(r.value), slot: r.context.slot }
  }

  async getMintInfo(mint: string): Promise<MintInfo> {
    const info = await inspectMint(this.connection, mint)
    this.mintMetaCache.set(mint, { programId: new PublicKey(info.tokenProgram), decimals: info.decimals })
    return info
  }

  async getTokenBalance(
    owner: string,
    mint: string,
    commitment: Commitment = 'confirmed',
  ): Promise<BalanceAt> {
    const ownerPk = new PublicKey(owner)
    const mintPk = new PublicKey(mint)
    const r = await this.rpc('getTokenAccountsByOwner', () =>
      this.connection.getTokenAccountsByOwner(ownerPk, { mint: mintPk }, commitment),
    )
    return { value: sumTokenAccounts(r.value, mintPk, ownerPk), slot: r.context.slot }
  }

  /**
   * Holdings for many owners at once: one ATA per owner (for the mint's program), read with
   * getMultipleAccounts in chunks of 100. Owners whose ATA is missing, empty, or not theirs (a legacy
   * SPL ATA can have its owner reassigned) fall back to getTokenAccountsByOwner so balances kept outside
   * the ATA still count. `slot` is the oldest context slot among the reads.
   */
  async getHoldings(owners: string[], mint: string): Promise<BalanceAt<Map<string, bigint>>> {
    const { programId } = await this.mintMeta(mint)
    const mintPk = new PublicKey(mint)
    const out = new Map<string, bigint>()
    const targets: { owner: string; ownerPk: PublicKey; ata: PublicKey }[] = []
    for (const owner of new Set(owners)) {
      let ownerPk: PublicKey
      try {
        ownerPk = new PublicKey(owner)
      } catch {
        out.set(owner, 0n) // not an address → holds nothing
        continue
      }
      targets.push({ owner, ownerPk, ata: getAssociatedTokenAddressSync(mintPk, ownerPk, true, programId) })
    }

    let slot = Number.POSITIVE_INFINITY
    const fallback: typeof targets = []
    const batches = chunk(targets, MULTIPLE_ACCOUNTS_CHUNK)
    const results = await mapLimit(batches, HOLDINGS_FALLBACK_CONCURRENCY, (batch) =>
      this.rpc('getMultipleAccountsInfo', () =>
        this.connection.getMultipleAccountsInfoAndContext(
          batch.map((t) => t.ata),
          'confirmed',
        ),
      ),
    )
    batches.forEach((batch, b) => {
      const r = results[b]!
      slot = Math.min(slot, r.context.slot)
      batch.forEach((t, i) => {
        const acc = r.value[i] ?? null
        const amount =
          acc && acc.owner.equals(programId) ? decodeTokenAccountAmount(acc.data, mintPk, t.ownerPk) : null
        if (amount !== null && amount > 0n) out.set(t.owner, amount)
        else fallback.push(t)
      })
    })

    await mapLimit(fallback, HOLDINGS_FALLBACK_CONCURRENCY, async (t) => {
      const r = await this.rpc('getTokenAccountsByOwner', () =>
        this.connection.getTokenAccountsByOwner(t.ownerPk, { mint: mintPk }, 'confirmed'),
      )
      slot = Math.min(slot, r.context.slot)
      out.set(t.owner, sumTokenAccounts(r.value, mintPk, t.ownerPk))
    })

    if (!Number.isFinite(slot)) slot = await this.getSlot('confirmed') // nothing was read (no valid owners)
    return { value: out, slot }
  }

  async ataExists(owner: string, mint: string): Promise<boolean> {
    const { programId } = await this.mintMeta(mint)
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, programId)
    return this.accountExists(ata)
  }

  // ── transactions ───────────────────────────────────────────────────────────
  async buildTransferTx(req: TransferTxRequest): Promise<BuiltTransferTx> {
    const signer = this.signerFor(req.signer)
    if (req.amountRaw <= 0n || req.amountRaw > U64_MAX) {
      throw new Error(`transfer amount must be in 1..u64::MAX (got ${req.amountRaw})`)
    }
    if (!Number.isFinite(req.priorityFeeMicroLamports) || req.priorityFeeMicroLamports < 0) {
      throw new Error(`invalid priority fee ${req.priorityFeeMicroLamports}`)
    }
    const mintPk = new PublicKey(req.mint)
    const recipientPk = new PublicKey(req.recipient)
    const { programId, decimals } = await this.mintMeta(req.mint)
    const source = getAssociatedTokenAddressSync(mintPk, signer.publicKey, false, programId)
    // off-curve recipients allowed here (e.g. a multisig OPS vault for the sweeper); player wallets are
    // validated as on-curve upstream
    const destination = getAssociatedTokenAddressSync(mintPk, recipientPk, true, programId)
    if (source.equals(destination)) throw new Error('refusing to build a transfer to the signer itself')

    const exists = await this.accountExists(destination)
    let transferIx: TransactionInstruction
    try {
      transferIx = await createTransferCheckedWithTransferHookInstruction(
        this.connection,
        source,
        mintPk,
        destination,
        signer.publicKey,
        req.amountRaw,
        decimals,
        [],
        'confirmed',
        programId,
      )
    } catch (e) {
      if (e instanceof TokenError)
        throw new Error(`transfer instruction for ${req.mint}: ${e.name}`, { cause: e })
      throw toChainError('resolve transfer-hook accounts', e)
    }
    const { blockhash, lastValidBlockHeight } = await this.rpc('getLatestBlockhash', () =>
      this.connection.getLatestBlockhash('confirmed'),
    )

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(req.priorityFeeMicroLamports) }),
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        destination,
        recipientPk,
        mintPk,
        programId,
      ),
      memoInstruction(req.memo, signer.publicKey),
      transferIx,
    ]
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message()
    const tx = new VersionedTransaction(message)
    tx.sign([signer])
    const bytes = tx.serialize()
    return {
      signature: bs58.encode(tx.signatures[0]!),
      bytes,
      blockhash,
      lastValidBlockHeight,
      createsAta: !exists,
    }
  }

  /** Simulate signed bytes as-is (no sig verify, no blockhash replacement). Classification happens upstream. */
  async simulate(bytes: Uint8Array): Promise<SimulationResult> {
    const tx = VersionedTransaction.deserialize(bytes)
    const r = await this.rpc('simulateTransaction', () =>
      this.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
      }),
    )
    const logs = r.value.logs ?? []
    const unitsConsumed = r.value.unitsConsumed ?? null
    if (r.value.err === null || r.value.err === undefined) {
      return { ok: true, error: null, permanent: false, logs, unitsConsumed }
    }
    return {
      ok: false,
      error: renderSimulationError(r.value.err, logs),
      permanent: false,
      logs,
      unitsConsumed,
    }
  }

  /** Broadcast signed bytes once (no preflight, no RPC-side retries — the payout worker re-broadcasts). */
  async sendRaw(bytes: Uint8Array): Promise<string> {
    try {
      return await this.connection.sendRawTransaction(bytes, { skipPreflight: true, maxRetries: 0 })
    } catch (e) {
      throw toChainError('sendRawTransaction', e)
    }
  }

  async getSignatureStatuses(signatures: string[]): Promise<SignatureStatuses> {
    const chunks = signatures.length === 0 ? [[]] : chunk(signatures, SIGNATURE_STATUS_CHUNK)
    const results = await Promise.all(
      chunks.map((c) =>
        this.rpc('getSignatureStatuses', () =>
          this.connection.getSignatureStatuses(c, { searchTransactionHistory: true }),
        ),
      ),
    )
    // an absence is only proven as of the OLDEST view that answered
    const contextSlot = Math.min(...results.map((r) => r.context.slot))
    const statuses: (SignatureStatus | null)[] = []
    results.forEach((r, i) => {
      const expected = chunks[i]!.length
      if (r.value.length !== expected) {
        throw new TransientChainError(
          `getSignatureStatuses returned ${r.value.length} results for ${expected}`,
        )
      }
      for (const s of r.value) {
        if (!s) {
          statuses.push(null)
          continue
        }
        statuses.push({
          slot: s.slot,
          confirmationStatus: s.confirmationStatus ?? (s.confirmations === null ? 'finalized' : null),
          err: s.err ? renderTxError(s.err) : null,
        })
      }
    })
    return { contextSlot, statuses }
  }

  /**
   * Compute-unit price (µ-lamports) for a payout: Helius getPriorityFeeEstimate (High) when the RPC is
   * Helius, else the 75th percentile of recent non-zero fees for txs write-locking PRIZE; never below
   * MIN_PRIORITY_FEE_MICROLAMPORTS. The caller applies its cap.
   */
  async estimatePriorityFee(): Promise<number> {
    const keys = [this.prizeAddress, TOKEN_2022_PROGRAM_ID.toBase58()]
    if (this.connection.rpcEndpoint.toLowerCase().includes('helius')) {
      const est = await this.heliusPriorityFee(keys)
      if (est !== null) return Math.max(MIN_PRIORITY_FEE_MICROLAMPORTS, Math.ceil(est))
    }
    let fees: { prioritizationFee: number }[]
    try {
      fees = await this.connection.getRecentPrioritizationFees({
        lockedWritableAccounts: keys.map((k) => new PublicKey(k)),
      })
    } catch {
      return Math.max(MIN_PRIORITY_FEE_MICROLAMPORTS, this.fallbackPriorityFee)
    }
    return Math.max(MIN_PRIORITY_FEE_MICROLAMPORTS, percentile75NonZero(fees.map((f) => f.prioritizationFee)))
  }

  async getPayoutTx(signature: string, mint: string, senderOwner: string): Promise<ParsedPayoutTx | null> {
    const tx = await this.rpc('getParsedTransaction', () =>
      this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }),
    )
    if (!tx) return null
    return parsePayoutTx(signature, tx, mint, senderOwner)
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private signerFor(role: SignerRole): Keypair {
    if (role === 'prize') return this.prize
    if (!this.creator) throw new Error('no CREATOR signer configured')
    return this.creator
  }

  private async mintMeta(mint: string): Promise<MintMeta> {
    const cached = this.mintMetaCache.get(mint)
    if (cached) return cached
    await this.getMintInfo(mint)
    return this.mintMetaCache.get(mint)!
  }

  private async accountExists(pk: PublicKey): Promise<boolean> {
    const info = await this.rpc('getAccountInfo', () => this.connection.getAccountInfo(pk, 'confirmed'))
    return info !== null
  }

  private async heliusPriorityFee(accountKeys: string[]): Promise<number | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), HELIUS_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(this.connection.rpcEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'scratchy-priority-fee',
          method: 'getPriorityFeeEstimate',
          params: [{ accountKeys, options: { priorityLevel: 'High' } }],
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) return null
      const body = (await res.json()) as { result?: { priorityFeeEstimate?: unknown } }
      const v = body.result?.priorityFeeEstimate
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
    } catch {
      return null // never surface the endpoint (it carries the API key); fall back to the RPC estimate
    } finally {
      clearTimeout(timer)
    }
  }

  private async rpc<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      throw toChainError(label, e)
    }
  }
}

// ── pure helpers (exported for tests and the rehearsal's verify pass) ────────

export function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, 'utf8'),
  })
}

/**
 * The raw amount of an SPL Token / Token-2022 account (the base layout is identical; Token-2022 adds
 * an account-type byte + TLV extensions after byte 165). Null if the data is not a token account for
 * `mint` (and, when given, owned by `owner`).
 */
export function decodeTokenAccountAmount(
  data: Uint8Array,
  mint: PublicKey,
  owner?: PublicKey,
): bigint | null {
  if (data.length < 165) return null
  if (!bytesEqual(data.subarray(0, 32), mint.toBytes())) return null
  if (owner && !bytesEqual(data.subarray(32, 64), owner.toBytes())) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return view.getBigUint64(TOKEN_ACCOUNT_AMOUNT_OFFSET, true)
}

function sumTokenAccounts(
  accounts: readonly { account: AccountInfo<Buffer> }[],
  mint: PublicKey,
  owner: PublicKey,
): bigint {
  let total = 0n
  for (const { account } of accounts) total += decodeTokenAccountAmount(account.data, mint, owner) ?? 0n
  return total
}

/** 75th percentile (nearest rank) of the non-zero values; 0 when there are none */
export function percentile75NonZero(values: number[]): number {
  const xs = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  if (xs.length === 0) return 0
  return Math.ceil(xs[Math.ceil(0.75 * xs.length) - 1]!)
}

const TOP_LEVEL_HINTS: Record<string, string> = {
  AccountNotFound: 'Attempt to debit an account but found no record of a prior credit',
  InsufficientFundsForFee: 'insufficient funds for fee',
  BlockhashNotFound: 'blockhash not found',
  AlreadyProcessed: 'transaction already processed',
}

/**
 * Render a TransactionError in the log-style wording the payout classifier matches
 * (`custom program error: 0x1`, `InsufficientFundsForRent`, …), followed by the raw JSON.
 */
export function renderTxError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error'
  if (typeof err === 'string') return TOP_LEVEL_HINTS[err] ? `${err}: ${TOP_LEVEL_HINTS[err]}` : err
  const json = safeJson(err)
  const ie = (err as { InstructionError?: unknown }).InstructionError
  if (Array.isArray(ie) && ie.length === 2) {
    const [index, inner] = ie as [unknown, unknown]
    if (inner && typeof inner === 'object' && 'Custom' in inner) {
      const code = Number((inner as { Custom: unknown }).Custom)
      return `instruction ${String(index)}: custom program error: 0x${code.toString(16)} ${json}`
    }
    return `instruction ${String(index)}: ${typeof inner === 'string' ? inner : safeJson(inner)} ${json}`
  }
  return json
}

const RELEVANT_LOG = /failed|error|insufficient|invalid|not enough|exceed|frozen|owner|mismatch/i

export function renderSimulationError(err: unknown, logs: string[]): string {
  const relevant = logs.filter((l) => RELEVANT_LOG.test(l)).slice(-6)
  const base = renderTxError(err)
  return relevant.length > 0 ? `${base} | logs: ${relevant.join(' | ')}` : base
}

const MEMO_LOG = /^Program log: Memo \(len \d+\): (".*")$/

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction

/**
 * Extract what the rehearsal's verify pass needs from a parsed payout transaction: memo, the
 * recipient (the owner of the transferChecked destination for `mint`) and net token deltas per owner.
 */
export function parsePayoutTx(
  signature: string,
  tx: ParsedTransactionWithMeta,
  mint: string,
  senderOwner: string,
): ParsedPayoutTx {
  const meta = tx.meta
  const ixs: AnyInstruction[] = tx.transaction.message.instructions
  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58())

  // memo: parsed spl-memo instruction first, the program log as a fallback
  let memo: string | null = null
  for (const ix of ixs) {
    if ('parsed' in ix && ix.program === 'spl-memo' && typeof ix.parsed === 'string') {
      memo = ix.parsed
      break
    }
  }
  if (memo === null) {
    for (const line of meta?.logMessages ?? []) {
      const m = MEMO_LOG.exec(line)
      if (!m) continue
      try {
        memo = JSON.parse(m[1]!) as string
      } catch {
        memo = m[1]!.slice(1, -1)
      }
      break
    }
  }

  // token account → owner, and net delta per owner, for this mint only
  const accountOwner = new Map<string, string>()
  const deltas = new Map<string, bigint>()
  for (const [balances, sign] of [
    [meta?.preTokenBalances ?? [], -1n],
    [meta?.postTokenBalances ?? [], 1n],
  ] as const) {
    for (const b of balances) {
      if (b.mint !== mint || !b.owner) continue
      const acct = accountKeys[b.accountIndex]
      if (acct) accountOwner.set(acct, b.owner)
      deltas.set(b.owner, (deltas.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount))
    }
  }
  for (const ix of ixs) {
    if (!('parsed' in ix) || ix.program !== 'spl-associated-token-account') continue
    const info = (ix.parsed as { info?: { account?: string; wallet?: string; mint?: string } } | null)?.info
    if (info?.account && info.wallet && info.mint === mint) accountOwner.set(info.account, info.wallet)
  }

  let recipientOwner: string | null = null
  for (const ix of ixs) {
    if (!('parsed' in ix) || (ix.program !== 'spl-token' && ix.program !== 'spl-token-2022')) continue
    const parsed = ix.parsed as { type?: string; info?: { destination?: string; mint?: string } } | null
    if (!parsed || (parsed.type !== 'transferChecked' && parsed.type !== 'transfer')) continue
    if (parsed.info?.mint !== undefined && parsed.info.mint !== mint) continue
    const owner = parsed.info?.destination ? accountOwner.get(parsed.info.destination) : undefined
    if (owner && owner !== senderOwner) {
      recipientOwner = owner
      break
    }
  }
  if (recipientOwner === null) {
    let best = 0n
    for (const [owner, d] of deltas) {
      if (owner !== senderOwner && d > best) {
        best = d
        recipientOwner = owner
      }
    }
  }

  return {
    signature,
    slot: tx.slot,
    err: meta?.err ? renderTxError(meta.err) : null,
    memo,
    recipientDeltaRaw: recipientOwner ? (deltas.get(recipientOwner) ?? 0n) : 0n,
    senderDeltaRaw: deltas.get(senderOwner) ?? 0n,
    recipientOwner,
  }
}

// ── error mapping ────────────────────────────────────────────────────────────

/** JSON-RPC codes that mean the request itself is wrong (retrying cannot help) */
const CALLER_ERROR_CODES = new Set([-32600, -32601, -32602])
const CALLER_ERROR_MESSAGE =
  /invalid param|method not found|failed to deserialize|signature verification fail/i

/** RPC failures are transient (network, 429, 5xx, node behind, timeouts…) unless the request was malformed. */
export function toChainError(label: string, e: unknown): Error {
  if (e instanceof TransientChainError) return e
  const message = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: unknown } | null)?.code
  if ((typeof code === 'number' && CALLER_ERROR_CODES.has(code)) || CALLER_ERROR_MESSAGE.test(message)) {
    return new Error(`${label}: ${message}`, { cause: e })
  }
  return new TransientChainError(`${label}: ${message}`, e)
}

// ── small utils ──────────────────────────────────────────────────────────────

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))
  } catch {
    return String(v)
  }
}
