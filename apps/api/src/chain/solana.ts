import {
  ACCOUNT_SIZE,
  AccountState,
  AccountType,
  addExtraAccountMetasForExecute,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  getMint,
  getTransferHook,
  MULTISIG_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TokenError,
  type Mint,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type ConfirmedTransactionMeta,
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
  type OwnerTokenDeltas,
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
 *   [4] transferChecked from the signer's ATA. The mint is re-read for every build: with no hook program
 *       (the real PUMP mint carries the extension with the program unset) it is a plain transferChecked
 *       and nothing else is fetched; with a hook program set, the extra accounts are resolved from the
 *       hook's validation account, which must exist and be owned by that program (else the build refuses)
 *
 * The message is v0, signed with the role's keypair; ed25519 signatures are deterministic, so identical
 * inputs + blockhash give identical bytes and signature — the payout worker's resend-identical-bytes
 * protocol relies on this. RPC trouble surfaces as TransientChainError (callers retry, never mark a
 * payout permanent); only caller errors (invalid params) and decoding bugs throw plain Errors.
 */

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const DEFAULT_COMPUTE_UNIT_LIMIT = 120_000
/** bounds a per-request TransferTxRequest.computeUnitLimit is clamped to */
export const MIN_COMPUTE_UNIT_LIMIT = 20_000
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000
export const MIN_PRIORITY_FEE_MICROLAMPORTS = 1_000
export const DEFAULT_FALLBACK_PRIORITY_FEE_MICROLAMPORTS = 20_000
export const SIGNATURE_STATUS_CHUNK = 256
export const MULTIPLE_ACCOUNTS_CHUNK = 100
/** getHoldings: parallel getTokenAccountsByOwner discovery calls */
export const HOLDINGS_DISCOVERY_CONCURRENCY = 4
/** getHoldings: an owner's discovered token-account list is refreshed once it is this old */
export const HOLDINGS_DISCOVERY_TTL_MS = 60 * 60 * 1000
/** getHoldings: re-issues of the whole read when the chunks answered at different slots */
export const HOLDINGS_SAME_SLOT_RETRIES = 4
export const DEFAULT_HOLDINGS_RETRY_DELAY_MS = 200
export const HELIUS_TIMEOUT_MS = 3_000
/** SPL Token / Token-2022 account layout: mint (0..32), owner (32..64), amount u64 LE (64..72), state (108) */
export const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
export const TOKEN_ACCOUNT_STATE_OFFSET = 108

const U64_MAX = (1n << 64n) - 1n
/** JSON-RPC "Minimum context slot has not been reached" */
const MIN_CONTEXT_SLOT_NOT_REACHED = -32016

/** The subset of `fetch` used for the Helius fee estimate (injected so tests never touch the network). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface SolanaChainClientOptions {
  connection: Connection
  cluster: SolanaClusterName
  prize: Keypair
  creator: Keypair | null
  /** default compute-unit limit when a TransferTxRequest does not name one */
  computeUnitLimit?: number
  /** priority fee returned when no estimate can be obtained at all (µ-lamports; the caller still caps) */
  fallbackPriorityFeeMicroLamports?: number
  fetch?: FetchFn
  /** clock for the holdings discovery cache (injected by tests) */
  now?: () => number
  /** pause before re-issuing a holdings read that did not land on one slot */
  holdingsRetryDelayMs?: number
}

interface MintMeta {
  programId: PublicKey
  decimals: number
}

interface DiscoveredAccounts {
  /** token-account addresses (base58) to read for this owner; the ATA is always included */
  accounts: string[]
  at: number
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
  private readonly now: () => number
  private readonly holdingsRetryDelayMs: number
  /** decimals + owning program never change for a mint, so they are cached for the process lifetime */
  private readonly mintMetaCache = new Map<string, MintMeta>()
  /** `${mint}:${owner}` → which token accounts to read for that owner (addresses only, never amounts) */
  private readonly discovery = new Map<string, DiscoveredAccounts>()

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
    this.now = opts.now ?? (() => Date.now())
    this.holdingsRetryDelayMs = opts.holdingsRetryDelayMs ?? DEFAULT_HOLDINGS_RETRY_DELAY_MS
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
   * The owner's associated token account only — what a transfer from `owner` can actually spend. 0 when
   * the ATA is missing, is not a token account of `mint` held by `owner` (a legacy SPL ATA can have its
   * owner reassigned), or is frozen (it cannot send).
   */
  async getAtaBalance(owner: string, mint: string, commitment: Commitment = 'confirmed'): Promise<BalanceAt> {
    const { programId } = await this.mintMeta(mint)
    const mintPk = new PublicKey(mint)
    const ownerPk = new PublicKey(owner)
    const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, true, programId)
    const r = await this.rpc('getAccountInfo', () =>
      this.connection.getAccountInfoAndContext(ata, commitment),
    )
    const acc = r.value
    const t = acc && acc.owner.equals(programId) ? decodeTokenAccount(acc.data) : null
    const spendable =
      t !== null &&
      t.state === AccountState.Initialized &&
      bytesEqual(t.mint, mintPk.toBytes()) &&
      bytesEqual(t.owner, ownerPk.toBytes())
    return { value: spendable ? t.amount : 0n, slot: r.context.slot }
  }

  /**
   * Holdings for many owners, every token account of every owner read at ONE common slot, so tokens moved
   * between accounts (or owners) mid-read can never be counted twice.
   *
   *  1. discovery — which accounts to read: an in-memory owner → [token-account addresses] list per mint
   *     (the ATA always included), refreshed with getTokenAccountsByOwner when missing or older than 1 h.
   *     Only addresses are taken from these reads, never amounts.
   *  2. one getMultipleAccounts read of every discovered address (chunks of 100, issued concurrently with
   *     the same minContextSlot), accepted only when every chunk answered at the same context slot;
   *     otherwise re-issued (minContextSlot = highest slot seen) up to HOLDINGS_SAME_SLOT_RETRIES times,
   *     then TransientChainError so the round start retries.
   *  3. each account read is a token account of `mint` (checked by program, mint field and layout) and is
   *     credited to the owner in its owner field at that slot — an account whose owner changed since
   *     discovery no longer counts for the old owner. Each address is read and counted once.
   */
  async getHoldings(owners: string[], mint: string): Promise<BalanceAt<Map<string, bigint>>> {
    const { programId } = await this.mintMeta(mint)
    const mintPk = new PublicKey(mint)
    const out = new Map<string, bigint>()
    const targets: { owner: string; ownerPk: PublicKey }[] = []
    for (const owner of new Set(owners)) {
      out.set(owner, 0n)
      try {
        targets.push({ owner, ownerPk: new PublicKey(owner) })
      } catch {
        // not an address → holds nothing
      }
    }
    if (targets.length === 0) return { value: out, slot: await this.getSlot('confirmed') }

    // 1) discovery (addresses only)
    const now = this.now()
    for (const [k, d] of this.discovery) if (now - d.at >= HOLDINGS_DISCOVERY_TTL_MS) this.discovery.delete(k)
    const stale = targets.filter((t) => !this.discovery.has(discoveryKey(mint, t.owner)))
    let discoveredAt: number | undefined
    await mapLimit(stale, HOLDINGS_DISCOVERY_CONCURRENCY, async (t) => {
      const r = await this.rpc('getTokenAccountsByOwner', () =>
        this.connection.getTokenAccountsByOwner(t.ownerPk, { mint: mintPk }, 'confirmed'),
      )
      const ata = getAssociatedTokenAddressSync(mintPk, t.ownerPk, true, programId).toBase58()
      const accounts = [...new Set([ata, ...r.value.map((a) => a.pubkey.toBase58())])]
      this.discovery.set(discoveryKey(mint, t.owner), { accounts, at: now })
      discoveredAt = Math.max(discoveredAt ?? 0, r.context.slot)
    })

    // 2) every discovered account at one slot
    const addresses = new Set<string>()
    for (const t of targets) {
      for (const a of this.discovery.get(discoveryKey(mint, t.owner))?.accounts ?? []) addresses.add(a)
    }
    const keys = [...addresses].map((a) => new PublicKey(a))
    const read = await this.readAccountsAtOneSlot(keys, discoveredAt)

    // 3) credit each token account of this mint to its current owner (if that owner was asked about)
    const mintBytes = mintPk.toBytes()
    const asked = new Map(targets.map((t) => [t.ownerPk.toBase58(), t.owner]))
    for (const acc of read.value) {
      if (!acc || !acc.owner.equals(programId)) continue
      const t = decodeTokenAccount(acc.data)
      if (!t || t.amount === 0n || !bytesEqual(t.mint, mintBytes)) continue
      const owner = asked.get(new PublicKey(t.owner).toBase58())
      if (owner !== undefined) out.set(owner, (out.get(owner) ?? 0n) + t.amount)
    }
    return { value: out, slot: read.slot }
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
    const units = this.computeUnits(req.computeUnitLimit)
    const mintPk = new PublicKey(req.mint)
    const recipientPk = new PublicKey(req.recipient)
    const { programId } = await this.mintMeta(req.mint)
    const source = getAssociatedTokenAddressSync(mintPk, signer.publicKey, false, programId)
    // off-curve recipients allowed here (e.g. a multisig OPS vault for the sweeper); player wallets are
    // validated as on-curve upstream
    const destination = getAssociatedTokenAddressSync(mintPk, recipientPk, true, programId)
    if (source.equals(destination)) throw new Error('refusing to build a transfer to the signer itself')

    const exists = await this.accountExists(destination)
    const transferIx = await this.transferInstruction(
      req.mint,
      programId,
      source,
      destination,
      signer.publicKey,
      req.amountRaw,
    )
    const { blockhash, lastValidBlockHeight } = await this.rpc('getLatestBlockhash', () =>
      this.connection.getLatestBlockhash('confirmed'),
    )

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
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
   * Helius, else the 75th percentile of the non-zero GLOBAL recent prioritization fees (no account filter —
   * the PRIZE wallet is write-locked by little besides our own payouts, so a filtered sample says nothing
   * about the market); never below MIN_PRIORITY_FEE_MICROLAMPORTS, and the configured fallback when the
   * RPC cannot answer. The caller applies its cap.
   */
  async estimatePriorityFee(): Promise<number> {
    if (this.connection.rpcEndpoint.toLowerCase().includes('helius')) {
      const est = await this.heliusPriorityFee([this.prizeAddress, TOKEN_2022_PROGRAM_ID.toBase58()])
      if (est !== null) return Math.max(MIN_PRIORITY_FEE_MICROLAMPORTS, Math.ceil(est))
    }
    let fees: { prioritizationFee: number }[]
    try {
      fees = await this.connection.getRecentPrioritizationFees()
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

  /**
   * Exact token deltas of `owner` from the confirmed tx's own pre/post token balances (every account whose
   * owner is `owner`, per mint). null when the RPC does not know the signature; TransientChainError when it
   * knows it but cannot say who moved what (no meta / no token balances) — never a guessed zero.
   */
  async getOwnerTokenDeltas(signature: string, owner: string): Promise<OwnerTokenDeltas | null> {
    const tx = await this.rpc('getTransaction', () =>
      this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
    )
    if (!tx) return null
    if (!tx.meta) throw new TransientChainError(`getTransaction(${signature}): the RPC returned no meta`)
    return {
      signature,
      slot: tx.slot,
      err: tx.meta.err ? renderTxError(tx.meta.err) : null,
      deltas: ownerTokenDeltas(signature, tx.meta, owner),
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private signerFor(role: SignerRole): Keypair {
    if (role === 'prize') return this.prize
    if (!this.creator) throw new Error('no CREATOR signer configured')
    return this.creator
  }

  /** the request's compute-unit limit clamped to [MIN, MAX], or the client default when it names none */
  private computeUnits(requested: number | undefined): number {
    if (requested === undefined) return this.computeUnitLimit
    if (!Number.isFinite(requested)) throw new Error(`invalid compute unit limit ${requested}`)
    return Math.min(MAX_COMPUTE_UNIT_LIMIT, Math.max(MIN_COMPUTE_UNIT_LIMIT, Math.floor(requested)))
  }

  /**
   * transferChecked for the mint as it is NOW (re-read, so a hook program set at runtime is seen).
   *
   * No hook program (no extension, or the program is the default key): a plain transferChecked and no
   * further RPC. Token-2022 makes no hook CPI then, and resolving extras would read the extra-account-metas
   * PDA derived from the default program id — an address anyone can fund, which would break every build.
   *
   * Hook program set: its validation PDA must exist and be owned by the hook program; the extra accounts
   * are resolved from exactly that account. Anything else — missing/foreign validation account, a list
   * that cannot be decoded or resolved, an extra account demanding a signature — is a plain Error (not
   * transient): retrying cannot fix it and nothing may be sent until an operator looks.
   */
  private async transferInstruction(
    mint: string,
    programId: PublicKey,
    source: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    amount: bigint,
  ): Promise<TransactionInstruction> {
    const mintPk = new PublicKey(mint)
    let state: Mint
    try {
      state = await getMint(this.connection, mintPk, 'confirmed', programId)
    } catch (e) {
      if (e instanceof TokenError)
        throw new Error(`transfer instruction for ${mint}: ${e.name}`, { cause: e })
      throw toChainError('getMint', e)
    }
    const ix = createTransferCheckedInstruction(
      source,
      mintPk,
      destination,
      owner,
      amount,
      state.decimals,
      [],
      programId,
    )
    const hook = getTransferHook(state)
    if (!hook || hook.programId.equals(PublicKey.default)) return ix

    const hookProgram = hook.programId
    const refuse = (why: string, cause?: unknown) =>
      new Error(
        `transfer hook ${hookProgram.toBase58()} of mint ${mint} cannot be resolved: ${why}`,
        cause === undefined ? undefined : { cause },
      )
    const validation = getExtraAccountMetaAddress(mintPk, hookProgram)
    const validationInfo = await this.rpc('getAccountInfo(transfer-hook validation account)', () =>
      this.connection.getAccountInfo(validation, 'confirmed'),
    )
    if (!validationInfo) throw refuse(`validation account ${validation.toBase58()} does not exist`)
    if (!validationInfo.owner.equals(hookProgram)) {
      throw refuse(
        `validation account ${validation.toBase58()} is owned by ${validationInfo.owner.toBase58()}, not the hook program`,
      )
    }

    // resolve from exactly the account checked above; account-data seeds still read through the RPC
    const view = {
      getAccountInfo: (pk: PublicKey) =>
        pk.equals(validation)
          ? Promise.resolve(validationInfo)
          : this.rpc('getAccountInfo(transfer-hook extra account)', () =>
              this.connection.getAccountInfo(pk, 'confirmed'),
            ),
    } as unknown as Connection
    const baseKeys = ix.keys.length
    try {
      await addExtraAccountMetasForExecute(
        view,
        ix,
        hookProgram,
        source,
        mintPk,
        destination,
        owner,
        amount,
        'confirmed',
      )
    } catch (e) {
      if (e instanceof TransientChainError) throw e
      throw refuse(e instanceof Error ? e.message || e.name : String(e), e)
    }
    const extras = ix.keys.slice(baseKeys)
    if (!extras.some((k) => k.pubkey.equals(validation))) throw refuse('extra accounts were not appended')
    if (extras.some((k) => k.isSigner)) throw refuse('an extra account demands a signature')
    return ix
  }

  /**
   * getMultipleAccounts over `keys` in chunks of 100, all issued concurrently with one minContextSlot, and
   * accepted only when every chunk answered at the same context slot (see getHoldings).
   */
  private async readAccountsAtOneSlot(
    keys: PublicKey[],
    minContextSlot: number | undefined,
  ): Promise<BalanceAt<(AccountInfo<Buffer> | null)[]>> {
    const chunks = chunk(keys, MULTIPLE_ACCOUNTS_CHUNK)
    let floor = minContextSlot
    let last = 'no attempt'
    for (let attempt = 0; attempt <= HOLDINGS_SAME_SLOT_RETRIES; attempt++) {
      if (attempt > 0 && this.holdingsRetryDelayMs > 0) await sleep(this.holdingsRetryDelayMs)
      const config: { commitment: 'confirmed'; minContextSlot?: number } = { commitment: 'confirmed' }
      if (floor !== undefined) config.minContextSlot = floor
      let results: Awaited<ReturnType<Connection['getMultipleAccountsInfoAndContext']>>[]
      try {
        results = await Promise.all(
          chunks.map((c) => this.connection.getMultipleAccountsInfoAndContext(c, config)),
        )
      } catch (e) {
        if (!isMinContextSlotError(e)) throw toChainError('getMultipleAccountsInfo', e)
        last = `a node had not reached slot ${floor}`
        continue
      }
      results.forEach((r, i) => {
        if (r.value.length !== chunks[i]!.length) {
          throw new TransientChainError(
            `getMultipleAccountsInfo returned ${r.value.length} accounts for ${chunks[i]!.length}`,
          )
        }
      })
      const slots = results.map((r) => r.context.slot)
      const top = Math.max(...slots)
      if (slots.every((s) => s === top)) return { value: results.flatMap((r) => r.value), slot: top }
      last = `chunks answered at slots ${[...new Set(slots)].join(', ')}`
      floor = top
    }
    throw new TransientChainError(
      `holdings read did not land on one slot after ${HOLDINGS_SAME_SLOT_RETRIES + 1} attempts (${last})`,
    )
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

export interface DecodedTokenAccount {
  /** raw 32-byte mint and owner fields */
  mint: Uint8Array
  owner: Uint8Array
  amount: bigint
  /** AccountState: 1 = Initialized, 2 = Frozen */
  state: number
}

/**
 * The base fields of an SPL Token / Token-2022 token account (the base layout is identical; Token-2022
 * adds an account-type byte + TLV extensions after byte 165, so 165- and 175-byte accounts both decode).
 * Null when the data is not an initialized token account: too short, a Token-2022 mint (account type
 * byte ≠ Account), a multisig (355 bytes), or uninitialized. The caller checks the program owner.
 */
export function decodeTokenAccount(data: Uint8Array): DecodedTokenAccount | null {
  if (data.length < ACCOUNT_SIZE) return null
  if (
    data.length > ACCOUNT_SIZE &&
    (data.length === MULTISIG_SIZE || data[ACCOUNT_SIZE] !== AccountType.Account)
  ) {
    return null
  }
  const state = data[TOKEN_ACCOUNT_STATE_OFFSET]!
  if (state !== AccountState.Initialized && state !== AccountState.Frozen) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    mint: data.subarray(0, 32),
    owner: data.subarray(32, 64),
    amount: view.getBigUint64(TOKEN_ACCOUNT_AMOUNT_OFFSET, true),
    state,
  }
}

/**
 * The raw amount of a token account (see decodeTokenAccount). Null if the data is not a token account
 * for `mint` (and, when given, owned by `owner`).
 */
export function decodeTokenAccountAmount(
  data: Uint8Array,
  mint: PublicKey,
  owner?: PublicKey,
): bigint | null {
  const t = decodeTokenAccount(data)
  if (!t || !bytesEqual(t.mint, mint.toBytes())) return null
  if (owner && !bytesEqual(t.owner, owner.toBytes())) return null
  return t.amount
}

/**
 * Net token change per mint of every token account owned by `owner` in one transaction, from its own
 * meta: Σ post − Σ pre over the balances whose owner is `owner` (an account only in post counts pre = 0 —
 * created in the tx; only in pre counts post = 0 — closed in the tx). Zero nets are omitted.
 * Throws TransientChainError when the meta cannot attribute balances (no token balances recorded, or an
 * entry without an owner) rather than returning a map that would read as "nothing moved".
 */
export function ownerTokenDeltas(
  signature: string,
  meta: Pick<ConfirmedTransactionMeta, 'preTokenBalances' | 'postTokenBalances'>,
  owner: string,
): Map<string, bigint> {
  const pre = meta.preTokenBalances
  const post = meta.postTokenBalances
  if (!pre || !post) {
    throw new TransientChainError(`transaction ${signature}: the RPC did not return token balances`)
  }
  const net = new Map<string, bigint>()
  for (const [balances, sign] of [
    [pre, -1n],
    [post, 1n],
  ] as const) {
    for (const b of balances) {
      if (!b.owner) {
        throw new TransientChainError(`transaction ${signature}: a token balance has no owner`)
      }
      if (b.owner !== owner) continue
      net.set(b.mint, (net.get(b.mint) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount))
    }
  }
  for (const [mint, d] of net) if (d === 0n) net.delete(mint)
  return net
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

/** run `fn` over `items` with at most `limit` in flight; after the first failure no new item starts */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i]!)
      } catch (e) {
        failed = true
        throw e
      }
    }
  })
  await Promise.all(workers)
  return out
}

function discoveryKey(mint: string, owner: string): string {
  return `${mint}:${owner}`
}

function isMinContextSlotError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  const message = e instanceof Error ? e.message : String(e)
  return code === MIN_CONTEXT_SLOT_NOT_REACHED || /minimum context slot/i.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
