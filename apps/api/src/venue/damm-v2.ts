import {
  CpAmm,
  derivePoolAuthority,
  derivePositionNftAccount,
  deriveTokenVaultAddress,
  getTokenProgram,
  getUnClaimLpFee,
  type PoolState as DammPoolState,
  type PositionState as DammPositionState,
} from '@meteora-ag/cp-amm-sdk'
import { pow10 } from '@scratchy/core'
import { getMint } from '@solana/spl-token'
import type { Connection, Keypair, PublicKey, Signer, Transaction } from '@solana/web3.js'
import type { BalanceAt } from '../chain/types'
import { sendAndConfirmSignedWithSlot, type ConfirmedTx } from './send'
import type { ClaimResult, PoolState, VenueAdapter } from './types'

/**
 * Meteora DAMM v2 venue adapter (PLAN §3 fee sweeper; plan "Venue"): SCRATCHY/PUMP custom pool, flat 3%
 * base fee, collectFeeMode = OnlyB (fees accrue only in PUMP), one permanently locked position owned by
 * CREATOR whose fees are claimed with claimPositionFee2.
 *
 *  - price: from the pool's sqrtPrice (Q64.64), in exact integer math — sqrtPrice² · 10^(decA−decB) / 2^128
 *    is the SDK's getPriceFromSqrtPrice formula, but the SDK evaluates it with decimal.js at its default
 *    20 significant digits; we evaluate it exactly in bigint, then floor once at 1e18. Never a reserve ratio.
 *  - orientation: our pools are tokenA = SCRATCHY (base), tokenB = PUMP (quote); a pool created the other
 *    way round is supported by inverting (price and fee/reserve mapping), validated on first use.
 *  - claimFees: the returned amounts are CREATOR's measured balance deltas around the confirmed claim tx
 *    (NOT the pending estimate); the post-claim read is pinned to a view at/after the landing slot.
 *
 * SDK-heavy calls are kept behind small functions (loadPoolStatics, pendingFeesFromStates,
 * runMeasuredClaim, …) so the math and orchestration are unit-tested without a cluster; the real
 * DAMM v2 path is exercised by the devnet smoke script.
 */

const Q128 = 1n << 128n

// ── exact price math ─────────────────────────────────────────────────────────

function assertDecimals(d: number, label: string): void {
  if (!Number.isInteger(d) || d < 0 || d > 30) throw new RangeError(`${label}: invalid decimals ${d}`)
}

/** Price of 1 whole token A in whole token B × 1e18 (floor), from a Q64.64 sqrtPrice. */
export function sqrtPriceToPriceE18(sqrtPriceX64: bigint, decA: number, decB: number): bigint {
  if (sqrtPriceX64 <= 0n) throw new RangeError('sqrtPrice must be > 0')
  assertDecimals(decA, 'tokenA')
  assertDecimals(decB, 'tokenB')
  const k = decA - decB + 18
  const num = sqrtPriceX64 * sqrtPriceX64 * (k >= 0 ? pow10(k) : 1n)
  const den = Q128 * (k < 0 ? pow10(-k) : 1n)
  return num / den
}

/** Price of 1 whole token B in whole token A × 1e18 (floor): 2^128 · 10^(decB−decA+18) / sqrtPrice². */
export function sqrtPriceToInversePriceE18(sqrtPriceX64: bigint, decA: number, decB: number): bigint {
  if (sqrtPriceX64 <= 0n) throw new RangeError('sqrtPrice must be > 0')
  assertDecimals(decA, 'tokenA')
  assertDecimals(decB, 'tokenB')
  const k = decB - decA + 18
  const num = Q128 * (k >= 0 ? pow10(k) : 1n)
  const den = sqrtPriceX64 * sqrtPriceX64 * (k < 0 ? pow10(-k) : 1n)
  return num / den
}

// ── orientation ──────────────────────────────────────────────────────────────

/** 'base-is-a': tokenA = SCRATCHY, tokenB = PUMP (our pools). 'base-is-b': the inverted layout. */
export type PoolOrientation = 'base-is-a' | 'base-is-b'

export function orientPool(
  tokenAMint: string,
  tokenBMint: string,
  baseMint: string,
  quoteMint: string,
): PoolOrientation {
  if (baseMint === quoteMint) throw new Error('base and quote mints must differ')
  if (tokenAMint === baseMint && tokenBMint === quoteMint) return 'base-is-a'
  if (tokenAMint === quoteMint && tokenBMint === baseMint) return 'base-is-b'
  throw new Error(
    `DAMM v2 pool mints (A=${tokenAMint}, B=${tokenBMint}) do not match the configured ` +
      `SCRATCHY=${baseMint} / PUMP=${quoteMint}`,
  )
}

/** Map a token A / token B pair onto base (SCRATCHY) / quote (PUMP). */
export function toBaseQuote<T>(a: T, b: T, orientation: PoolOrientation): { base: T; quote: T } {
  return orientation === 'base-is-a' ? { base: a, quote: b } : { base: b, quote: a }
}

/** PUMP per whole SCRATCHY × 1e18 for either orientation (exact, floor). */
export function poolPriceQuotePerBaseE18(
  sqrtPriceX64: bigint,
  decA: number,
  decB: number,
  orientation: PoolOrientation,
): bigint {
  return orientation === 'base-is-a'
    ? sqrtPriceToPriceE18(sqrtPriceX64, decA, decB)
    : sqrtPriceToInversePriceE18(sqrtPriceX64, decA, decB)
}

// ── state helpers ────────────────────────────────────────────────────────────

const bnToBig = (v: { toString(): string }): bigint => BigInt(v.toString())

/** Raw amount of an SPL / Token-2022 token account (base layout: mint 0..32, owner 32..64, amount 64..72). */
export function readTokenAmount(data: Uint8Array): bigint {
  if (data.length < 72) throw new Error(`not a token account (${data.length} bytes)`)
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(64)
}

/** Owner (authority) bytes of an SPL / Token-2022 token account. */
export function readTokenOwner(data: Uint8Array): Uint8Array {
  if (data.length < 72) throw new Error(`not a token account (${data.length} bytes)`)
  return data.subarray(32, 64)
}

/**
 * Position liquidity used for the fee share = unlockedLiquidity + vestedLiquidity + permanentLockedLiquidity
 * (the same three fields the program — and the SDK's positionLiquidity() — accrue fees on).
 */
export function positionTotalLiquidity(position: DammPositionState): bigint {
  return (
    bnToBig(position.unlockedLiquidity) +
    bnToBig(position.vestedLiquidity) +
    bnToBig(position.permanentLockedLiquidity)
  )
}

/** position liquidity / pool liquidity as a float in [0, 1] (parts-per-billion resolution). */
export function liquidityShare(positionLiquidity: bigint, poolLiquidity: bigint): number {
  if (poolLiquidity <= 0n || positionLiquidity <= 0n) return 0
  const ppb = (positionLiquidity * 1_000_000_000n) / poolLiquidity
  return Math.min(1, Number(ppb) / 1e9)
}

/** Claimable fees (raw) for a position, mapped to base/quote. Uses the SDK's getUnClaimLpFee. */
export function pendingFeesFromStates(
  poolState: DammPoolState,
  positionState: DammPositionState,
  orientation: PoolOrientation,
): { quoteRaw: bigint; baseRaw: bigint } {
  const { feeTokenA, feeTokenB } = getUnClaimLpFee(poolState, positionState)
  const m = toBaseQuote(bnToBig(feeTokenA), bnToBig(feeTokenB), orientation)
  return { quoteRaw: m.quote, baseRaw: m.base }
}

// ── balances ─────────────────────────────────────────────────────────────────

/**
 * Total raw balance of `owner` for `mint` across all its token accounts at 'confirmed', answered from a
 * view at or after `minContextSlot` when given.
 */
export type TokenBalanceReader = (
  owner: PublicKey,
  mint: PublicKey,
  minContextSlot?: number,
) => Promise<BalanceAt>

const MIN_SLOT_RETRIES = 8
const MIN_SLOT_RETRY_MS = 500

/** getTokenAccountsByOwner(mint filter — works for SPL and Token-2022) summed; retries a lagging RPC view. */
export function rpcBalanceReader(
  connection: Pick<Connection, 'getTokenAccountsByOwner'>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): TokenBalanceReader {
  return async (owner, mint, minContextSlot) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await connection.getTokenAccountsByOwner(
          owner,
          { mint },
          minContextSlot === undefined
            ? { commitment: 'confirmed' }
            : { commitment: 'confirmed', minContextSlot },
        )
        let total = 0n
        for (const { account } of res.value) total += readTokenAmount(account.data)
        return { value: total, slot: res.context.slot }
      } catch (e) {
        const lagging = /minimum context slot/i.test((e as Error).message ?? '')
        if (!lagging || attempt >= MIN_SLOT_RETRIES) throw e
        await sleep(MIN_SLOT_RETRY_MS)
      }
    }
  }
}

export interface BaseQuoteBalances {
  base: BalanceAt
  quote: BalanceAt
}

export function makeBaseQuoteReader(
  reader: TokenBalanceReader,
  owner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
): (minContextSlot?: number) => Promise<BaseQuoteBalances> {
  return async (minContextSlot) => {
    const [base, quote] = await Promise.all([
      reader(owner, baseMint, minContextSlot),
      reader(owner, quoteMint, minContextSlot),
    ])
    return { base, quote }
  }
}

// ── claim orchestration (unit-tested with stubs) ─────────────────────────────

export class ClaimMeasurementError extends Error {
  constructor(
    message: string,
    readonly signatures: string[],
  ) {
    super(message)
    this.name = 'ClaimMeasurementError'
  }
}

export interface ClaimSteps {
  pending(): Promise<{ quoteRaw: bigint; baseRaw: bigint }>
  readBalances(minContextSlot?: number): Promise<BaseQuoteBalances>
  sendClaim(): Promise<ConfirmedTx>
  /** a lower bound for the pre-claim read's view (e.g. the slot of this venue's previous tx) */
  minSlotBefore?: number
}

/**
 * pending == 0 on both sides → no tx, zeros. Otherwise: read CREATOR's balances, claim (confirmed),
 * re-read from a view at/after the landing slot, and return the deltas. A negative delta (something else
 * moved CREATOR's tokens concurrently) or a stale post-claim view throws with the claim signature attached,
 * so the sweeper re-measures instead of trusting a wrong number.
 */
export async function runMeasuredClaim(steps: ClaimSteps): Promise<ClaimResult> {
  const pending = await steps.pending()
  if (pending.quoteRaw === 0n && pending.baseRaw === 0n) {
    return { signatures: [], claimedQuoteRaw: 0n, claimedBaseRaw: 0n }
  }
  const before = await steps.readBalances(steps.minSlotBefore)
  const tx = await steps.sendClaim()
  const after = await steps.readBalances(tx.slot)
  const sigs = [tx.signature]
  if (after.base.slot < tx.slot || after.quote.slot < tx.slot) {
    throw new ClaimMeasurementError(
      `claim ${tx.signature} landed at slot ${tx.slot} but the balance view is older ` +
        `(base@${after.base.slot}, quote@${after.quote.slot}); re-measure`,
      sigs,
    )
  }
  const claimedQuoteRaw = after.quote.value - before.quote.value
  const claimedBaseRaw = after.base.value - before.base.value
  if (claimedQuoteRaw < 0n || claimedBaseRaw < 0n) {
    throw new ClaimMeasurementError(
      `claim ${tx.signature}: CREATOR balance dropped across the claim ` +
        `(PUMP Δ${claimedQuoteRaw}, SCRATCHY Δ${claimedBaseRaw}) — concurrent transfer? re-measure`,
      sigs,
    )
  }
  return { signatures: sigs, claimedQuoteRaw, claimedBaseRaw }
}

// ── pool statics (validated once) ────────────────────────────────────────────

export interface PoolStatics {
  pool: PublicKey
  orientation: PoolOrientation
  tokenAMint: PublicKey
  tokenBMint: PublicKey
  tokenAVault: PublicKey
  tokenBVault: PublicKey
  tokenAProgram: PublicKey
  tokenBProgram: PublicKey
  decA: number
  decB: number
  collectFeeMode: number
}

export type CpAmmLike = Pick<
  CpAmm,
  | 'fetchPoolState'
  | 'fetchPositionState'
  | 'getUserPositionByPool'
  | 'claimPositionFee2'
  | 'getQuote'
  | 'swap2'
>

/** Fetch the pool, validate its mints against SCRATCHY/PUMP and load both mints' decimals (right program). */
export async function loadPoolStatics(
  connection: Connection,
  cpAmm: Pick<CpAmm, 'fetchPoolState'>,
  pool: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
): Promise<{ statics: PoolStatics; poolState: DammPoolState }> {
  const poolState = await cpAmm.fetchPoolState(pool)
  const orientation = orientPool(
    poolState.tokenAMint.toBase58(),
    poolState.tokenBMint.toBase58(),
    baseMint.toBase58(),
    quoteMint.toBase58(),
  )
  const tokenAProgram = getTokenProgram(poolState.tokenAFlag)
  const tokenBProgram = getTokenProgram(poolState.tokenBFlag)
  // getMint also asserts the mint account is owned by that program (flag sanity check)
  const [mintA, mintB] = await Promise.all([
    getMint(connection, poolState.tokenAMint, 'confirmed', tokenAProgram),
    getMint(connection, poolState.tokenBMint, 'confirmed', tokenBProgram),
  ])
  return {
    poolState,
    statics: {
      pool,
      orientation,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram,
      tokenBProgram,
      decA: mintA.decimals,
      decB: mintB.decimals,
      collectFeeMode: poolState.collectFeeMode,
    },
  }
}

function assertSamePool(poolState: DammPoolState, s: PoolStatics): void {
  if (!poolState.tokenAMint.equals(s.tokenAMint) || !poolState.tokenBMint.equals(s.tokenBMint)) {
    throw new Error(`DAMM v2 pool ${s.pool.toBase58()} mints changed since init — refusing`)
  }
}

// ── the adapter ──────────────────────────────────────────────────────────────

export interface DammV2VenueOptions {
  connection: Connection
  /** CREATOR: owns the position NFT, signs + pays for claims, receives the fees */
  creator: Keypair
  pool: PublicKey
  position: PublicKey
  /** SCRATCHY */
  baseMint: PublicKey
  /** PUMP (devnet: the mock PUMP mint) */
  quoteMint: PublicKey
  /** test seams; production uses the real SDK / RPC */
  cpAmm?: CpAmmLike
  balanceReader?: TokenBalanceReader
  send?: (tx: Transaction, signers: Signer[]) => Promise<ConfirmedTx>
}

interface VenueStatics extends PoolStatics {
  positionNftMint: PublicKey
  positionNftAccount: PublicKey
}

export class DammV2Venue implements VenueAdapter {
  readonly name = 'damm-v2'
  private readonly connection: Connection
  private readonly creator: Keypair
  private readonly pool: PublicKey
  private readonly position: PublicKey
  private readonly baseMint: PublicKey
  private readonly quoteMint: PublicKey
  private readonly cpAmm: CpAmmLike
  private readonly readBalances: (minContextSlot?: number) => Promise<BaseQuoteBalances>
  private readonly send: (tx: Transaction, signers: Signer[]) => Promise<ConfirmedTx>
  private statics: VenueStatics | null = null
  private initializing: Promise<VenueStatics> | null = null
  /** landing slot of this venue's last confirmed tx — lower bound for the next pre-claim read */
  private lastTxSlot: number | undefined

  constructor(opts: DammV2VenueOptions) {
    if (opts.baseMint.equals(opts.quoteMint)) throw new Error('DammV2Venue: base and quote mints must differ')
    this.connection = opts.connection
    this.creator = opts.creator
    this.pool = opts.pool
    this.position = opts.position
    this.baseMint = opts.baseMint
    this.quoteMint = opts.quoteMint
    this.cpAmm = opts.cpAmm ?? new CpAmm(opts.connection)
    this.readBalances = makeBaseQuoteReader(
      opts.balanceReader ?? rpcBalanceReader(opts.connection),
      opts.creator.publicKey,
      opts.baseMint,
      opts.quoteMint,
    )
    this.send =
      opts.send ??
      ((tx, signers) =>
        sendAndConfirmSignedWithSlot(this.connection, tx, signers, { label: 'damm-v2 claimPositionFee2' }))
  }

  /** Construct and validate (pool mints, decimals, position ↔ pool, CREATOR holds the position NFT). */
  static async create(opts: DammV2VenueOptions): Promise<DammV2Venue> {
    const v = new DammV2Venue(opts)
    await v.init()
    return v
  }

  /** Idempotent; every public async method calls it. Retries on the next call if it failed. */
  init(): Promise<VenueStatics> {
    if (this.statics) return Promise.resolve(this.statics)
    this.initializing ??= this.load().then(
      (s) => {
        this.statics = s
        return s
      },
      (e: unknown) => {
        this.initializing = null
        throw e
      },
    )
    return this.initializing
  }

  private async load(): Promise<VenueStatics> {
    const { statics } = await loadPoolStatics(
      this.connection,
      this.cpAmm,
      this.pool,
      this.baseMint,
      this.quoteMint,
    )
    const positionState = await this.cpAmm.fetchPositionState(this.position)
    if (!positionState.pool.equals(this.pool)) {
      throw new Error(
        `DAMM v2 position ${this.position.toBase58()} belongs to pool ${positionState.pool.toBase58()}, ` +
          `not ${this.pool.toBase58()}`,
      )
    }
    // The NFT normally sits in the program's PDA account ["position_nft_account", nftMint]; if it was moved
    // to another CREATOR account, find it among CREATOR's positions in this pool.
    let positionNftAccount = derivePositionNftAccount(positionState.nftMint)
    if (!(await this.holdsPositionNft(positionNftAccount, positionState.nftMint))) {
      const mine = await this.cpAmm.getUserPositionByPool(this.pool, this.creator.publicKey)
      const hit = mine.find((p) => p.position.equals(this.position))
      if (!hit || !(await this.holdsPositionNft(hit.positionNftAccount, positionState.nftMint))) {
        throw new Error(
          `CREATOR ${this.creator.publicKey.toBase58()} does not hold the NFT of position ` +
            `${this.position.toBase58()} (it can't claim this position's fees)`,
        )
      }
      positionNftAccount = hit.positionNftAccount
    }
    return { ...statics, positionNftMint: positionState.nftMint, positionNftAccount }
  }

  /** the token account holds exactly 1 of the position NFT with CREATOR as its authority */
  private async holdsPositionNft(account: PublicKey, nftMint: PublicKey): Promise<boolean> {
    const info = await this.connection.getAccountInfo(account, 'confirmed')
    if (!info || info.data.length < 72) return false
    const mint = info.data.subarray(0, 32)
    const holder = readTokenOwner(info.data)
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
    return (
      same(mint, nftMint.toBytes()) &&
      same(holder, this.creator.publicKey.toBytes()) &&
      readTokenAmount(info.data) === 1n
    )
  }

  /**
   * Pool, both vaults, position, position NFT account and the pool authority. Before init() the vaults are
   * the program's derived PDAs (["token_vault", mint, pool]) and the NFT account is unknown; after init they
   * come from the validated on-chain state. Call create()/init() at boot.
   */
  excludedAddresses(): string[] {
    const s = this.statics
    const out = [this.pool, this.position, derivePoolAuthority()]
    if (s) out.push(s.tokenAVault, s.tokenBVault, s.positionNftAccount)
    else
      out.push(
        deriveTokenVaultAddress(this.baseMint, this.pool),
        deriveTokenVaultAddress(this.quoteMint, this.pool),
      )
    return [...new Set(out.map((k) => k.toBase58()))]
  }

  async getPoolState(): Promise<PoolState> {
    const s = await this.init()
    const poolState = await this.cpAmm.fetchPoolState(this.pool)
    assertSamePool(poolState, s)
    const vaults = await this.connection.getMultipleAccountsInfoAndContext(
      [s.tokenAVault, s.tokenBVault],
      'confirmed',
    )
    const [va, vb] = vaults.value
    if (!va || !vb) throw new Error(`DAMM v2 pool ${this.pool.toBase58()}: vault account missing`)
    const reserves = toBaseQuote(readTokenAmount(va.data), readTokenAmount(vb.data), s.orientation)
    const decimals = toBaseQuote(s.decA, s.decB, s.orientation)
    return {
      address: this.pool.toBase58(),
      baseMint: this.baseMint.toBase58(),
      quoteMint: this.quoteMint.toBase58(),
      baseDecimals: decimals.base,
      quoteDecimals: decimals.quote,
      baseReserveRaw: reserves.base,
      quoteReserveRaw: reserves.quote,
      priceQuotePerBaseE18: poolPriceQuotePerBaseE18(
        bnToBig(poolState.sqrtPrice),
        s.decA,
        s.decB,
        s.orientation,
      ),
      slot: vaults.context.slot,
    }
  }

  async pendingFees(): Promise<{ quoteRaw: bigint; baseRaw: bigint }> {
    const s = await this.init()
    const [poolState, positionState] = await Promise.all([
      this.cpAmm.fetchPoolState(this.pool),
      this.cpAmm.fetchPositionState(this.position),
    ])
    assertSamePool(poolState, s)
    return pendingFeesFromStates(poolState, positionState, s.orientation)
  }

  async claimFees(): Promise<ClaimResult> {
    const s = await this.init()
    return runMeasuredClaim({
      pending: () => this.pendingFees(),
      readBalances: (minSlot) => this.readBalances(minSlot),
      minSlotBefore: this.lastTxSlot,
      sendClaim: async () => {
        const tx = await this.cpAmm.claimPositionFee2({
          owner: this.creator.publicKey,
          position: this.position,
          pool: this.pool,
          positionNftAccount: s.positionNftAccount,
          tokenAMint: s.tokenAMint,
          tokenBMint: s.tokenBMint,
          tokenAVault: s.tokenAVault,
          tokenBVault: s.tokenBVault,
          tokenAProgram: s.tokenAProgram,
          tokenBProgram: s.tokenBProgram,
          receiver: this.creator.publicKey,
          feePayer: this.creator.publicKey,
        })
        const sent = await this.send(tx, [this.creator])
        this.lastTxSlot = sent.slot
        return sent
      },
    })
  }

  async creatorLiquidityShare(): Promise<number> {
    const s = await this.init()
    const [poolState, positionState] = await Promise.all([
      this.cpAmm.fetchPoolState(this.pool),
      this.cpAmm.fetchPositionState(this.position),
    ])
    assertSamePool(poolState, s)
    return liquidityShare(positionTotalLiquidity(positionState), bnToBig(poolState.liquidity))
  }
}
