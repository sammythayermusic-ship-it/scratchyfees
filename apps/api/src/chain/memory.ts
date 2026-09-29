import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import bs58 from 'bs58'
import {
  TransientChainError,
  type BalanceAt,
  type BuiltTransferTx,
  type ChainClient,
  type Commitment,
  type MintInfo,
  type ParsedPayoutTx,
  type SignatureStatuses,
  type SimulationResult,
  type TransferTxRequest,
} from './types'

/**
 * In-process chain for tests, local dev (`CHAIN_MODE=memory`) and load tests. It models what matters
 * for payout safety: blocks advance, blockhashes expire after `validityBlocks`, finalized lags confirmed,
 * identical transaction bytes have identical signatures (so re-broadcasts never double-apply), fees and
 * ATA rent are charged to the signer, and faults can be injected (drops, on-chain errors, send errors,
 * lagging RPC views, simulation failures).
 */

export const MEMORY_FEE_LAMPORTS = 5_000n
export const MEMORY_ATA_RENT_LAMPORTS = 2_108_880n // Token-2022 account (175 bytes), rent-exempt

export interface MemoryMint {
  address: string
  decimals: number
  token2022?: boolean
  extensions?: string[]
  transferHookProgram?: string | null
  blockingExtensions?: string[]
}

export interface MemoryFaults {
  /** the next N sent transactions are accepted by "RPC" but never land */
  dropNext?: number
  /** the next N landed transactions fail on-chain with this error (fee still charged) */
  failNextOnChain?: { count: number; error: string }
  /** the next N sendRaw calls throw a transient error without delivering */
  sendThrowsNext?: number
  /** getSignatureStatuses answers from a view this many slots behind (load-balanced RPC lag) */
  statusLagSlots?: number
  /** simulate() returns this error for the next N calls */
  simulateErrorNext?: { count: number; error: string; permanent: boolean }
  /** every RPC read throws (transient) — to exercise retry paths */
  rpcDown?: boolean
}

interface MemTx {
  signature: string
  req: TransferTxRequest
  signerAddress: string
  blockhash: string
  lastValidBlockHeight: number
  createsAta: boolean
  landAtHeight: number | null
  landedSlot: number | null
  err: string | null
  memo: string
  recipientDelta: bigint
  senderDelta: bigint
}

interface Delta {
  slot: number
  key: string
  amount: bigint
}

export interface MemoryChainOptions {
  prizeAddress: string
  creatorAddress?: string | null
  mints: MemoryMint[]
  /** blocks a blockhash stays valid (real Solana ≈ 150) */
  validityBlocks?: number
  /** blocks between confirmed and finalized */
  finalityLag?: number
  /** blocks from send to landing */
  landingDelay?: number
  /** advance one block every N ms automatically (dev mode); tests advance manually */
  autoAdvanceMs?: number
}

export class MemoryChainClient implements ChainClient {
  readonly cluster = 'memory' as const
  readonly prizeAddress: string
  readonly creatorAddress: string | null
  faults: MemoryFaults = {}

  private height = 1_000
  private readonly validityBlocks: number
  private readonly finalityLag: number
  private readonly landingDelay: number
  private readonly mints = new Map<string, MemoryMint>()
  private readonly sol = new Map<string, bigint>()
  private readonly tokens = new Map<string, bigint>()
  private readonly atas = new Set<string>()
  private readonly txs = new Map<string, MemTx>()
  private readonly history: Delta[] = []
  private timer: NodeJS.Timeout | null = null
  /** every sendRaw call (including duplicates) — tests assert re-broadcast behaviour */
  readonly sendLog: string[] = []

  constructor(opts: MemoryChainOptions) {
    this.prizeAddress = opts.prizeAddress
    this.creatorAddress = opts.creatorAddress ?? null
    this.validityBlocks = opts.validityBlocks ?? 150
    this.finalityLag = opts.finalityLag ?? 2
    this.landingDelay = opts.landingDelay ?? 1
    for (const m of opts.mints) this.mints.set(m.address, m)
    if (opts.autoAdvanceMs) {
      this.timer = setInterval(() => this.advance(1), opts.autoAdvanceMs)
      this.timer.unref()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ── test / dev helpers ─────────────────────────────────────────────────────
  get currentHeight(): number {
    return this.height
  }
  setSol(owner: string, lamports: bigint): void {
    this.sol.set(owner, lamports)
  }
  /** mint tokens into `owner` (creates its ATA) */
  credit(owner: string, mint: string, raw: bigint): void {
    this.requireMint(mint)
    this.atas.add(key(owner, mint))
    this.applyToken(owner, mint, raw)
  }
  /** move tokens between owners outside the payout path (simulates a user sell/buy or a stranger's dust) */
  transferExternal(from: string, to: string, mint: string, raw: bigint): void {
    if (this.tokenOf(from, mint) < raw) throw new Error('insufficient balance for external transfer')
    this.atas.add(key(to, mint))
    this.applyToken(from, mint, -raw)
    this.applyToken(to, mint, raw)
  }
  /** close an owner's ATA (Decision D scenario: rent farming) — balance must be zero */
  closeAta(owner: string, mint: string): void {
    if (this.tokenOf(owner, mint) !== 0n) throw new Error('cannot close a non-empty account')
    this.atas.delete(key(owner, mint))
  }
  /** advance the chain N blocks, landing due transactions */
  advance(blocks = 1): void {
    for (let i = 0; i < blocks; i++) {
      this.height++
      for (const tx of this.txs.values()) {
        if (tx.landAtHeight === this.height && tx.landedSlot === null) this.land(tx)
      }
    }
  }
  txCount(): number {
    return [...this.txs.values()].filter((t) => t.landedSlot !== null && t.err === null).length
  }
  landedTransfers(): MemTx[] {
    return [...this.txs.values()].filter((t) => t.landedSlot !== null && t.err === null)
  }

  // ── ChainClient ────────────────────────────────────────────────────────────
  async verifyCluster(): Promise<void> {}

  async getSlot(commitment: Commitment = 'confirmed'): Promise<number> {
    this.rpc()
    return commitment === 'finalized' ? this.height - this.finalityLag : this.height
  }

  async getHeightAndSlot(
    commitment: Commitment = 'confirmed',
  ): Promise<{ blockHeight: number; slot: number }> {
    this.rpc()
    const h = commitment === 'finalized' ? this.height - this.finalityLag : this.height
    return { blockHeight: h, slot: h }
  }

  async getSolBalance(owner: string, commitment: Commitment = 'confirmed'): Promise<BalanceAt> {
    this.rpc()
    return { value: this.sol.get(owner) ?? 0n, slot: await this.getSlot(commitment) }
  }

  async getMintInfo(mint: string): Promise<MintInfo> {
    this.rpc()
    const m = this.requireMint(mint)
    return {
      address: m.address,
      decimals: m.decimals,
      tokenProgram: m.token2022
        ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
        : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      isToken2022: !!m.token2022,
      supply: 0n,
      extensions: m.extensions ?? [],
      transferHookProgram: m.transferHookProgram ?? null,
      blockingExtensions: m.blockingExtensions ?? [],
    }
  }

  async getTokenBalance(
    owner: string,
    mint: string,
    commitment: Commitment = 'confirmed',
  ): Promise<BalanceAt> {
    this.rpc()
    const slot = await this.getSlot(commitment)
    let value = this.tokenOf(owner, mint)
    if (commitment === 'finalized') {
      const k = key(owner, mint)
      for (const d of this.history) if (d.key === k && d.slot > slot) value -= d.amount
    }
    return { value, slot }
  }

  async getHoldings(owners: string[], mint: string): Promise<BalanceAt<Map<string, bigint>>> {
    this.rpc()
    const out = new Map<string, bigint>()
    for (const o of owners) out.set(o, this.tokenOf(o, mint))
    return { value: out, slot: this.height }
  }

  async ataExists(owner: string, mint: string): Promise<boolean> {
    this.rpc()
    return this.atas.has(key(owner, mint))
  }

  async buildTransferTx(req: TransferTxRequest): Promise<BuiltTransferTx> {
    this.rpc()
    this.requireMint(req.mint)
    const signerAddress = this.signerAddress(req.signer)
    const blockhash = `mem-bh-${this.height}`
    const lastValidBlockHeight = this.height + this.validityBlocks
    const body = JSON.stringify({
      ...req,
      amountRaw: req.amountRaw.toString(),
      signerAddress,
      blockhash,
      lastValidBlockHeight,
    })
    const signature = bs58.encode(sha256(utf8ToBytes(body)))
    return {
      signature,
      bytes: utf8ToBytes(body),
      blockhash,
      lastValidBlockHeight,
      createsAta: !this.atas.has(key(req.recipient, req.mint)),
    }
  }

  async simulate(bytes: Uint8Array): Promise<SimulationResult> {
    this.rpc()
    const f = this.faults.simulateErrorNext
    if (f && f.count > 0) {
      f.count--
      return { ok: false, error: f.error, permanent: f.permanent, logs: [], unitsConsumed: null }
    }
    const tx = this.decode(bytes)
    const check = this.preflight(tx)
    return { ok: check === null, error: check, permanent: false, logs: [], unitsConsumed: 30_000 }
  }

  async sendRaw(bytes: Uint8Array): Promise<string> {
    if (this.faults.sendThrowsNext && this.faults.sendThrowsNext > 0) {
      this.faults.sendThrowsNext--
      throw new TransientChainError('memory: send failed (injected)')
    }
    this.rpc()
    const tx = this.decode(bytes)
    this.sendLog.push(tx.signature)
    const known = this.txs.get(tx.signature)
    if (known) return known.signature // identical bytes → same signature → never applied twice
    if (this.height > tx.lastValidBlockHeight) throw new Error('Blockhash not found')
    if (this.faults.dropNext && this.faults.dropNext > 0) {
      this.faults.dropNext--
      tx.landAtHeight = null // accepted, never lands
    } else {
      tx.landAtHeight = this.height + this.landingDelay
    }
    this.txs.set(tx.signature, tx)
    return tx.signature
  }

  async getSignatureStatuses(signatures: string[]): Promise<SignatureStatuses> {
    this.rpc()
    const contextSlot = this.height - (this.faults.statusLagSlots ?? 0)
    const finalized = this.height - this.finalityLag
    return {
      contextSlot,
      statuses: signatures.map((s) => {
        const tx = this.txs.get(s)
        if (!tx || tx.landedSlot === null || tx.landedSlot > contextSlot) return null
        return {
          slot: tx.landedSlot,
          confirmationStatus: tx.landedSlot <= finalized ? 'finalized' : 'confirmed',
          err: tx.err,
        }
      }),
    }
  }

  async estimatePriorityFee(): Promise<number> {
    return 1_000
  }

  async getPayoutTx(signature: string): Promise<ParsedPayoutTx | null> {
    this.rpc()
    const tx = this.txs.get(signature)
    if (!tx || tx.landedSlot === null) return null
    return {
      signature,
      slot: tx.landedSlot,
      err: tx.err,
      memo: tx.memo,
      recipientDeltaRaw: tx.err ? 0n : tx.recipientDelta,
      senderDeltaRaw: tx.err ? 0n : tx.senderDelta,
      recipientOwner: tx.req.recipient,
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private rpc(): void {
    if (this.faults.rpcDown) throw new TransientChainError('memory: RPC unavailable (injected)')
  }

  private signerAddress(role: 'prize' | 'creator'): string {
    if (role === 'prize') return this.prizeAddress
    if (!this.creatorAddress) throw new Error('no CREATOR signer configured')
    return this.creatorAddress
  }

  private requireMint(mint: string): MemoryMint {
    const m = this.mints.get(mint)
    if (!m) throw new Error(`unknown mint ${mint}`)
    return m
  }

  private tokenOf(owner: string, mint: string): bigint {
    return this.tokens.get(key(owner, mint)) ?? 0n
  }

  private applyToken(owner: string, mint: string, amount: bigint): void {
    const k = key(owner, mint)
    this.tokens.set(k, (this.tokens.get(k) ?? 0n) + amount)
    this.history.push({ slot: this.height, key: k, amount })
  }

  private decode(bytes: Uint8Array): MemTx {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as TransferTxRequest & {
      amountRaw: string
      signerAddress: string
      blockhash: string
      lastValidBlockHeight: number
    }
    const req: TransferTxRequest = {
      signer: body.signer,
      recipient: body.recipient,
      mint: body.mint,
      amountRaw: BigInt(body.amountRaw),
      memo: body.memo,
      priorityFeeMicroLamports: body.priorityFeeMicroLamports,
    }
    return {
      signature: bs58.encode(sha256(bytes)),
      req,
      signerAddress: body.signerAddress,
      blockhash: body.blockhash,
      lastValidBlockHeight: body.lastValidBlockHeight,
      createsAta: false,
      landAtHeight: null,
      landedSlot: null,
      err: null,
      memo: req.memo,
      recipientDelta: 0n,
      senderDelta: 0n,
    }
  }

  /** returns an error string if the tx would fail, else null */
  private preflight(tx: MemTx): string | null {
    const needsAta = !this.atas.has(key(tx.req.recipient, tx.req.mint))
    const lamportsNeeded = MEMORY_FEE_LAMPORTS + (needsAta ? MEMORY_ATA_RENT_LAMPORTS : 0n)
    if ((this.sol.get(tx.signerAddress) ?? 0n) < lamportsNeeded) {
      return 'Attempt to debit an account but found no record of a prior credit (insufficient SOL)'
    }
    if (this.tokenOf(tx.signerAddress, tx.req.mint) < tx.req.amountRaw) {
      return 'Program Token: insufficient funds'
    }
    return null
  }

  private land(tx: MemTx): void {
    if (this.height > tx.lastValidBlockHeight) return // expired before landing: never lands
    const solBal = this.sol.get(tx.signerAddress) ?? 0n
    if (solBal < MEMORY_FEE_LAMPORTS) return // cannot pay the fee: the leader drops it (never lands)
    tx.landedSlot = this.height
    this.sol.set(tx.signerAddress, solBal - MEMORY_FEE_LAMPORTS) // fee is charged even if the tx fails
    const injected = this.faults.failNextOnChain
    if (injected && injected.count > 0) {
      injected.count--
      tx.err = injected.error
      return
    }
    if (this.tokenOf(tx.signerAddress, tx.req.mint) < tx.req.amountRaw) {
      tx.err = 'Program Token: insufficient funds'
      return
    }
    const needsAta = !this.atas.has(key(tx.req.recipient, tx.req.mint))
    if (needsAta) {
      const bal = this.sol.get(tx.signerAddress) ?? 0n
      if (bal < MEMORY_ATA_RENT_LAMPORTS) {
        tx.err = 'insufficient lamports for rent'
        return
      }
      this.sol.set(tx.signerAddress, bal - MEMORY_ATA_RENT_LAMPORTS)
      this.atas.add(key(tx.req.recipient, tx.req.mint))
      tx.createsAta = true
    }
    this.applyToken(tx.signerAddress, tx.req.mint, -tx.req.amountRaw)
    this.applyToken(tx.req.recipient, tx.req.mint, tx.req.amountRaw)
    tx.recipientDelta = tx.req.amountRaw
    tx.senderDelta = -tx.req.amountRaw
  }
}

function key(owner: string, mint: string): string {
  return `${owner}:${mint}`
}
