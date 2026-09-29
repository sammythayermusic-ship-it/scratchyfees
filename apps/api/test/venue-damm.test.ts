import {
  derivePoolAuthority,
  derivePositionNftAccount,
  deriveTokenVaultAddress,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  type PoolState as DammPoolState,
  type PositionState as DammPositionState,
} from '@meteora-ag/cp-amm-sdk'
import { decimalToScaled } from '@scratchy/core'
import { MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
} from '@solana/web3.js'
import BN from 'bn.js'
import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import {
  ClaimMeasurementError,
  DammV2Venue,
  liquidityShare,
  orientPool,
  pendingFeesFromStates,
  poolPriceQuotePerBaseE18,
  runMeasuredClaim,
  sqrtPriceToInversePriceE18,
  sqrtPriceToPriceE18,
  toBaseQuote,
  type CpAmmLike,
} from '../src/venue/damm-v2'
import {
  minOutWithSlippage,
  ownerTokenDeltasFromMeta,
  sendAndConfirmSigned,
  sendSignedAndConfirm,
  signWithFreshBlockhash,
  swapResultFromDeltas,
  txOwnerTokenDeltas,
  VenueTxError,
  type TxMetaConnection,
  type VenueSendConnection,
} from '../src/venue/send'
import { DammPoolSwap } from '../src/venue/swap-damm'
import {
  JUPITER_EXPIRY_MARGIN_BLOCKS,
  JupiterSwap,
  JupiterSwapError,
  type FetchFn,
} from '../src/venue/swap-jupiter'
import { NoSwap } from '../src/venue/swap-none'
import type { OnSwapSigned } from '../src/venue/types'

// ── independent big-number reference (decimal.js at 300 significant digits) ───
// The SDK returns decimal.js instances; clone its constructor with far more precision than it uses (20).

interface Dec {
  pow(e: number): Dec
  mul(x: Dec): Dec
  div(x: Dec): Dec
  floor(): Dec
  toFixed(dp: number): string
}
interface DecCtor {
  new (v: string | number): Dec
  clone(cfg: { precision: number }): DecCtor
}
const HiDec = (getPriceFromSqrtPrice(new BN(1), 0, 0).constructor as unknown as DecCtor).clone({
  precision: 300,
})
const d = (v: bigint | number) => new HiDec(v.toString())
const TEN = d(10)
const Q128 = d(2).pow(128)

/** floor(sqrt² · 10^(decA−decB) / 2^128 · 1e18) evaluated in decimal arithmetic */
function refPriceE18(sqrt: bigint, decA: number, decB: number): bigint {
  const v = d(sqrt)
    .pow(2)
    .mul(TEN.pow(decA - decB))
    .div(Q128)
    .mul(TEN.pow(18))
    .floor()
  return BigInt(v.toFixed(0))
}
/** floor(2^128 · 10^(decB−decA) / sqrt² · 1e18) */
function refInversePriceE18(sqrt: bigint, decA: number, decB: number): bigint {
  const v = Q128.mul(TEN.pow(decB - decA))
    .div(d(sqrt).pow(2))
    .mul(TEN.pow(18))
    .floor()
  return BigInt(v.toFixed(0))
}

/** deterministic 64..127-bit sqrt prices within the program's bounds */
function* sqrtSamples(): Generator<bigint> {
  let x = 0x9e3779b97f4a7c15n
  const lo = BigInt(MIN_SQRT_PRICE.toString())
  const hi = BigInt(MAX_SQRT_PRICE.toString())
  for (let i = 0; i < 40; i++) {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n)
    const bits = 64n + (x % 64n)
    const v = (x >> 3n) & ((1n << bits) - 1n)
    if (v >= lo && v <= hi) yield v
  }
}

const DECIMAL_COMBOS: Array<[number, number]> = [
  [6, 6],
  [9, 6],
  [6, 9],
  [9, 9],
  [0, 6],
  [6, 0],
]

describe('sqrtPrice → price × 1e18 (exact)', () => {
  it('matches known exact values', () => {
    const one = 1n << 64n // sqrtPrice for raw price 1
    expect(sqrtPriceToPriceE18(one, 6, 6)).toBe(10n ** 18n)
    expect(sqrtPriceToPriceE18(one, 9, 6)).toBe(10n ** 21n)
    expect(sqrtPriceToPriceE18(one, 6, 9)).toBe(10n ** 15n)
    expect(sqrtPriceToPriceE18(3n * one, 6, 6)).toBe(9n * 10n ** 18n)
    expect(sqrtPriceToInversePriceE18(3n * one, 6, 6)).toBe(10n ** 18n / 9n)
    expect(sqrtPriceToInversePriceE18(one, 9, 6)).toBe(10n ** 15n)
  })

  it('equals an independent 300-digit decimal reference for many decimal combos and prices', () => {
    let checked = 0
    for (const [decA, decB] of DECIMAL_COMBOS) {
      const samples = [
        ...['0.000001234', '0.0056652589', '1', '42.5', '1234567.891'].map((p) =>
          BigInt(getSqrtPriceFromPrice(p, decA, decB).toString()),
        ),
        BigInt(MIN_SQRT_PRICE.toString()),
        BigInt(MAX_SQRT_PRICE.toString()),
        1n << 64n,
        ...sqrtSamples(),
      ]
      for (const s of samples) {
        expect(sqrtPriceToPriceE18(s, decA, decB)).toBe(refPriceE18(s, decA, decB))
        expect(sqrtPriceToInversePriceE18(s, decA, decB)).toBe(refInversePriceE18(s, decA, decB))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it("agrees with the SDK's getPriceFromSqrtPrice (which is only 20 significant digits)", () => {
    for (const [decA, decB] of DECIMAL_COMBOS) {
      for (const p of ['0.0056652589', '1', '42.5']) {
        const s = getSqrtPriceFromPrice(p, decA, decB)
        const ours = sqrtPriceToPriceE18(BigInt(s.toString()), decA, decB)
        const sdk = decimalToScaled(getPriceFromSqrtPrice(s, decA, decB).toString(), 18)
        const diff = ours > sdk ? ours - sdk : sdk - ours
        expect(diff <= ours / 10n ** 18n + 1n).toBe(true)
        // and the price round-trips to what the pool was created at (Q64 floor error only)
        const want = decimalToScaled(p, 18)
        const err = ours > want ? ours - want : want - ours
        expect(err * 10n ** 12n <= want).toBe(true)
      }
    }
  })

  it('rejects non-positive sqrtPrice and bad decimals', () => {
    expect(() => sqrtPriceToPriceE18(0n, 6, 6)).toThrow()
    expect(() => sqrtPriceToInversePriceE18(-1n, 6, 6)).toThrow()
    expect(() => sqrtPriceToPriceE18(1n << 64n, 6.5, 6)).toThrow()
  })
})

// ── orientation ──────────────────────────────────────────────────────────────

const SCRATCHY = Keypair.generate().publicKey
const PUMP = Keypair.generate().publicKey

describe('mint orientation', () => {
  const S = SCRATCHY.toBase58()
  const P = PUMP.toBase58()

  it('detects normal and inverted pools and refuses foreign ones', () => {
    expect(orientPool(S, P, S, P)).toBe('base-is-a')
    expect(orientPool(P, S, S, P)).toBe('base-is-b')
    expect(() => orientPool(S, Keypair.generate().publicKey.toBase58(), S, P)).toThrow(/do not match/)
    expect(() => orientPool(S, P, S, S)).toThrow(/differ/)
    expect(toBaseQuote('a', 'b', 'base-is-a')).toEqual({ base: 'a', quote: 'b' })
    expect(toBaseQuote('a', 'b', 'base-is-b')).toEqual({ base: 'b', quote: 'a' })
  })

  it('gives the same PUMP-per-SCRATCHY price whichever way round the pool was created', () => {
    // 1 SCRATCHY (9 dp) = 0.0125 PUMP (6 dp)  ⇔  1 PUMP = 80 SCRATCHY
    const normal = BigInt(getSqrtPriceFromPrice('0.0125', 9, 6).toString())
    const inverted = BigInt(getSqrtPriceFromPrice('80', 6, 9).toString())
    const want = decimalToScaled('0.0125', 18)
    for (const got of [
      poolPriceQuotePerBaseE18(normal, 9, 6, 'base-is-a'),
      poolPriceQuotePerBaseE18(inverted, 6, 9, 'base-is-b'),
    ]) {
      const err = got > want ? got - want : want - got
      expect(err * 10n ** 12n <= want).toBe(true)
    }
    // inverted pool read naively (as if A were SCRATCHY) would be 80, not 0.0125
    expect(poolPriceQuotePerBaseE18(inverted, 6, 9, 'base-is-a') > 79n * 10n ** 18n).toBe(true)
  })
})

// ── pending fees / liquidity share ───────────────────────────────────────────

const X64 = 1n << 64n
function u256le(v: bigint): number[] {
  const out: number[] = []
  for (let i = 0; i < 32; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn))
  return out
}

interface FakePoolCfg {
  tokenAMint: PublicKey
  tokenBMint: PublicKey
  tokenAFlag: number
  tokenBFlag: number
  sqrtPrice: bigint
  liquidity: bigint
  feeAPerLiquidity?: bigint
  feeBPerLiquidity?: bigint
}
function fakePoolState(c: FakePoolCfg, pool: PublicKey): DammPoolState {
  return {
    tokenAMint: c.tokenAMint,
    tokenBMint: c.tokenBMint,
    tokenAVault: deriveTokenVaultAddress(c.tokenAMint, pool),
    tokenBVault: deriveTokenVaultAddress(c.tokenBMint, pool),
    tokenAFlag: c.tokenAFlag,
    tokenBFlag: c.tokenBFlag,
    collectFeeMode: 1,
    sqrtPrice: new BN(c.sqrtPrice.toString()),
    liquidity: new BN(c.liquidity.toString()),
    feeAPerLiquidity: u256le(c.feeAPerLiquidity ?? 0n),
    feeBPerLiquidity: u256le(c.feeBPerLiquidity ?? 0n),
    rewardInfos: [],
  } as unknown as DammPoolState
}
function fakePositionState(p: {
  pool: PublicKey
  nftMint: PublicKey
  unlocked?: bigint
  vested?: bigint
  permanent?: bigint
  feeAPending?: bigint
  feeBPending?: bigint
}): DammPositionState {
  return {
    pool: p.pool,
    nftMint: p.nftMint,
    feeAPerTokenCheckpoint: u256le(0n),
    feeBPerTokenCheckpoint: u256le(0n),
    feeAPending: new BN((p.feeAPending ?? 0n).toString()),
    feeBPending: new BN((p.feeBPending ?? 0n).toString()),
    unlockedLiquidity: new BN((p.unlocked ?? 0n).toString()),
    vestedLiquidity: new BN((p.vested ?? 0n).toString()),
    permanentLockedLiquidity: new BN((p.permanent ?? 0n).toString()),
    rewardInfos: [],
  } as unknown as DammPositionState
}

describe('pending fees and liquidity share', () => {
  const pool = Keypair.generate().publicKey
  it('maps getUnClaimLpFee onto base/quote for both orientations', () => {
    const ps = fakePoolState(
      {
        tokenAMint: SCRATCHY,
        tokenBMint: PUMP,
        tokenAFlag: 1,
        tokenBFlag: 1,
        sqrtPrice: X64,
        liquidity: 4000n * X64,
        feeAPerLiquidity: 2n * X64,
        feeBPerLiquidity: 5n * X64,
      },
      pool,
    )
    // position liquidity 1000·2^64 → fee = 1000·2^64 · k·2^64 >> 128 = 1000k, plus pending
    const pos = fakePositionState({
      pool,
      nftMint: PUMP,
      permanent: 1000n * X64,
      feeAPending: 3n,
      feeBPending: 7n,
    })
    expect(pendingFeesFromStates(ps, pos, 'base-is-a')).toEqual({ baseRaw: 2003n, quoteRaw: 5007n })
    expect(pendingFeesFromStates(ps, pos, 'base-is-b')).toEqual({ baseRaw: 5007n, quoteRaw: 2003n })
  })

  it('computes the liquidity share as a 0..1 float', () => {
    expect(liquidityShare(10n * X64, 40n * X64)).toBe(0.25)
    expect(liquidityShare(0n, 40n)).toBe(0)
    expect(liquidityShare(5n, 0n)).toBe(0)
    expect(liquidityShare(50n, 40n)).toBe(1)
    expect(liquidityShare(1n, 3n)).toBeCloseTo(1 / 3, 8)
  })
})

// ── fabricated transaction meta (getTransaction) ─────────────────────────────

interface Bal {
  owner: string | undefined
  mint: string
  amount: bigint
  /** defaults to the entry's position; pre/post entries of one account must share it */
  accountIndex?: number
}

function tokenBalance(b: Bal, i: number) {
  return {
    accountIndex: b.accountIndex ?? i,
    mint: b.mint,
    ...(b.owner === undefined ? {} : { owner: b.owner }),
    programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: { amount: b.amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' },
  }
}

function txResponse(p: { pre: Bal[]; post: Bal[]; err?: unknown; slot?: number }) {
  return {
    slot: p.slot ?? 1,
    blockTime: null,
    transaction: { message: {}, signatures: [] },
    meta: {
      err: p.err ?? null,
      fee: 5_000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: p.pre.map(tokenBalance),
      postTokenBalances: p.post.map(tokenBalance),
    },
  }
}

/** `owner` sells `inRaw` of `base` for `outRaw` of `quote` (quote ATA created in the tx), plus pool noise */
function swapTxResponse(
  owner: string,
  base: string,
  quote: string,
  inRaw: bigint,
  outRaw: bigint,
  opts: { err?: unknown } = {},
) {
  const vaultOwner = Keypair.generate().publicKey.toBase58()
  return txResponse({
    pre: [
      { owner, mint: base, amount: 5_000_000n, accountIndex: 1 },
      { owner: vaultOwner, mint: base, amount: 7_000_000n, accountIndex: 3 },
      { owner: vaultOwner, mint: quote, amount: 900_000n, accountIndex: 4 },
    ],
    post: [
      { owner, mint: base, amount: 5_000_000n - inRaw, accountIndex: 1 },
      { owner, mint: quote, amount: outRaw, accountIndex: 2 },
      { owner: vaultOwner, mint: base, amount: 7_000_000n + inRaw, accountIndex: 3 },
      { owner: vaultOwner, mint: quote, amount: 900_000n - outRaw, accountIndex: 4 },
    ],
    ...opts,
  })
}

const noSleep = async () => {}

// ── tx-meta deltas + swap booking ────────────────────────────────────────────

describe('ownerTokenDeltasFromMeta / txOwnerTokenDeltas', () => {
  const me = Keypair.generate().publicKey.toBase58()
  const other = Keypair.generate().publicKey.toBase58()
  const S = SCRATCHY.toBase58()
  const P = PUMP.toBase58()

  it('sums post − pre over all of the owner’s accounts per mint and ignores other owners', () => {
    const d = ownerTokenDeltasFromMeta(
      txResponse({
        pre: [
          { owner: me, mint: S, amount: 1_000n, accountIndex: 1 },
          { owner: me, mint: P, amount: 70n, accountIndex: 5 }, // closed in the tx (pre only)
          { owner: other, mint: S, amount: 9_999n, accountIndex: 3 },
        ],
        post: [
          { owner: me, mint: S, amount: 400n, accountIndex: 1 },
          { owner: me, mint: S, amount: 25n, accountIndex: 2 }, // created in the tx (post only)
          { owner: other, mint: S, amount: 10_599n, accountIndex: 3 },
        ],
      }).meta,
      me,
    )
    expect(d.get(S)).toBe(-575n)
    expect(d.get(P)).toBe(-70n)
    expect(d.size).toBe(2)
  })

  it('refuses a balance entry without an owner (it could be ours)', () => {
    const meta = txResponse({ pre: [], post: [{ owner: undefined, mint: S, amount: 1n }] }).meta
    expect(() => ownerTokenDeltasFromMeta(meta, me)).toThrow(/no owner/)
  })

  it('reads getTransaction(confirmed, v0) and retries while the RPC does not know the tx yet', async () => {
    const cfgs: unknown[] = []
    let calls = 0
    const conn = {
      getTransaction: async (sig: string, cfg: unknown) => {
        cfgs.push(cfg)
        calls++
        if (calls === 1) throw new Error('503')
        if (calls === 2) return null
        expect(sig).toBe('sig-1')
        return txResponse({ pre: [], post: [{ owner: me, mint: P, amount: 42n }] })
      },
    } as unknown as TxMetaConnection
    const d = await txOwnerTokenDeltas(conn, 'sig-1', new PublicKey(me), { sleep: noSleep })
    expect(d.get(P)).toBe(42n)
    expect(calls).toBe(3)
    expect(cfgs[0]).toEqual({ commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  })

  it('throws when the tx never shows up, has no meta, or failed on-chain', async () => {
    const never = { getTransaction: async () => null } as unknown as TxMetaConnection
    await expect(txOwnerTokenDeltas(never, 's', me, { attempts: 3, sleep: noSleep })).rejects.toThrow(
      /not returned by getTransaction after 3 attempts/,
    )
    const noMeta = { getTransaction: async () => ({ slot: 1, meta: null }) } as unknown as TxMetaConnection
    await expect(txOwnerTokenDeltas(noMeta, 's', me, { sleep: noSleep })).rejects.toThrow(/no meta/)
    const failed = {
      getTransaction: async () => txResponse({ pre: [], post: [], err: { InstructionError: [0, 'Custom'] } }),
    } as unknown as TxMetaConnection
    await expect(txOwnerTokenDeltas(failed, 's', me, { sleep: noSleep })).rejects.toThrow(/failed on-chain/)
  })
})

describe('swapResultFromDeltas', () => {
  const S = SCRATCHY.toBase58()
  const P = PUMP.toBase58()
  const want = { baseMint: S, quoteMint: P, amountInRaw: 1_000n, minOutRaw: 90n }
  const deltas = (base: bigint, quote?: bigint) => {
    const m = new Map<string, bigint>([[S, base]])
    if (quote !== undefined) m.set(P, quote)
    return m
  }

  it('books in = −Δbase, out = +Δquote when the tx did exactly what was signed', () => {
    expect(swapResultFromDeltas('sig', deltas(-1_000n, 95n), want)).toEqual({
      signature: 'sig',
      inRaw: 1_000n,
      outRaw: 95n,
    })
  })

  it('refuses a different input amount or an output below the signed minimum', () => {
    expect(() => swapResultFromDeltas('sig', deltas(-999n, 95n), want)).toThrow(/signed for exactly/)
    expect(() => swapResultFromDeltas('sig', deltas(-1_001n, 95n), want)).toThrow(/signed for exactly/)
    expect(() => swapResultFromDeltas('sig', deltas(-1_000n, 89n), want)).toThrow(/signed minimum/)
    expect(() => swapResultFromDeltas('sig', deltas(-1_000n), { ...want, minOutRaw: 0n })).toThrow(
      /signed minimum/,
    )
  })
})

// ── claim orchestration ──────────────────────────────────────────────────────

describe('runMeasuredClaim', () => {
  it('skips the claim entirely when nothing is pending', async () => {
    let sent = 0
    let measured = 0
    const r = await runMeasuredClaim({
      pending: async () => ({ quoteRaw: 0n, baseRaw: 0n }),
      sendClaim: async () => {
        sent++
        return { signature: 'x', slot: 1 }
      },
      claimDeltas: async () => {
        measured++
        return { quoteRaw: 1n, baseRaw: 0n }
      },
    })
    expect(r).toEqual({ signatures: [], claimedQuoteRaw: 0n, claimedBaseRaw: 0n })
    expect(sent).toBe(0)
    expect(measured).toBe(0)
  })

  it("returns the claim tx's own deltas (not the pending estimate)", async () => {
    const asked: string[] = []
    const r = await runMeasuredClaim({
      pending: async () => ({ quoteRaw: 9_999n, baseRaw: 0n }), // estimate differs from what lands
      sendClaim: async () => ({ signature: 'claimSig', slot: 120 }),
      claimDeltas: async (sig) => {
        asked.push(sig)
        return { quoteRaw: 4_321n, baseRaw: 0n }
      },
    })
    expect(r).toEqual({ signatures: ['claimSig'], claimedQuoteRaw: 4_321n, claimedBaseRaw: 0n })
    expect(asked).toEqual(['claimSig'])
  })

  it('throws (with the signature) on a negative delta', async () => {
    const p = runMeasuredClaim({
      pending: async () => ({ quoteRaw: 1n, baseRaw: 0n }),
      sendClaim: async () => ({ signature: 'sigNeg', slot: 120 }),
      claimDeltas: async () => ({ quoteRaw: 50n, baseRaw: -100n }),
    })
    await expect(p).rejects.toBeInstanceOf(ClaimMeasurementError)
    await expect(p).rejects.toMatchObject({ signatures: ['sigNeg'], signature: 'sigNeg' })
  })

  it('throws (with the signature) when the claim tx meta cannot be read', async () => {
    const p = runMeasuredClaim({
      pending: async () => ({ quoteRaw: 1n, baseRaw: 0n }),
      sendClaim: async () => ({ signature: 'sigLag', slot: 150 }),
      claimDeltas: async () => {
        throw new Error('not returned by getTransaction')
      },
    })
    await expect(p).rejects.toBeInstanceOf(ClaimMeasurementError)
    await expect(p).rejects.toMatchObject({ signatures: ['sigLag'], signature: 'sigLag' })
    await expect(p).rejects.toThrow(/could not be read/)
  })

  it('lets a send failure (which already carries its signature) through unchanged', async () => {
    const err = new VenueTxError('claim: timeout', 'timeout', 'sigT')
    const p = runMeasuredClaim({
      pending: async () => ({ quoteRaw: 1n, baseRaw: 0n }),
      sendClaim: async () => {
        throw err
      },
      claimDeltas: async () => ({ quoteRaw: 1n, baseRaw: 0n }),
    })
    await expect(p).rejects.toBe(err)
  })
})

// ── DammV2Venue wiring with fakes (no cluster) ───────────────────────────────

function mintAccount(decimals: number, program: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE)
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 10n ** 15n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  )
  return { data, owner: program, lamports: 1_000_000, executable: false, rentEpoch: 0 }
}
function tokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
  program: PublicKey,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(165)
  mint.toBuffer().copy(data, 0)
  owner.toBuffer().copy(data, 32)
  data.writeBigUInt64LE(amount, 64)
  data[108] = 1
  return { data, owner: program, lamports: 2_000_000, executable: false, rentEpoch: 0 }
}

interface VenueFixture {
  venue: DammV2Venue
  creator: Keypair
  pool: PublicKey
  position: PublicKey
  nftMint: PublicKey
  /** where CREATOR's NFT actually sits */
  nftAccount: PublicKey
  poolState: DammPoolState
  claimCalls: Array<Record<string, unknown>>
  txLookups: Array<{ sig: string; cfg: unknown }>
}

function venueFixture(opts: {
  inverted?: boolean
  pending?: { a: bigint; b: bigint }
  nftHolder?: PublicKey
  positionPool?: PublicKey
  /** the NFT was moved out of the PDA account into another CREATOR account */
  nftMoved?: boolean
  /** override what the claim tx's meta shows for CREATOR (default: the pending PUMP arrives) */
  claimMeta?: (creator: string) => { pre: Bal[]; post: Bal[] } | null
}): VenueFixture {
  const creator = Keypair.generate()
  const pool = Keypair.generate().publicKey
  const position = Keypair.generate().publicKey
  const nftMint = Keypair.generate().publicKey
  // SCRATCHY: SPL Token, 9 dp; PUMP: Token-2022, 6 dp
  const scratchyInfo = { mint: SCRATCHY, flag: 0, dec: 9, program: TOKEN_PROGRAM_ID }
  const pumpInfo = { mint: PUMP, flag: 1, dec: 6, program: TOKEN_2022_PROGRAM_ID }
  const [A, B] = opts.inverted ? [pumpInfo, scratchyInfo] : [scratchyInfo, pumpInfo]
  const sqrtPrice = BigInt(getSqrtPriceFromPrice(opts.inverted ? '80' : '0.0125', A.dec, B.dec).toString())
  const poolState = fakePoolState(
    {
      tokenAMint: A.mint,
      tokenBMint: B.mint,
      tokenAFlag: A.flag,
      tokenBFlag: B.flag,
      sqrtPrice,
      liquidity: 40n * X64,
    },
    pool,
  )
  const positionState = fakePositionState({
    pool: opts.positionPool ?? pool,
    nftMint,
    unlocked: 1n * X64,
    vested: 2n * X64,
    permanent: 7n * X64,
    feeAPending: opts.pending?.a ?? 0n,
    feeBPending: opts.pending?.b ?? 0n,
  })
  const vaultAmounts = new Map([
    [poolState.tokenAVault.toBase58(), 111_000n],
    [poolState.tokenBVault.toBase58(), 222_000n],
  ])
  const nftAccount = opts.nftMoved ? Keypair.generate().publicKey : derivePositionNftAccount(nftMint)
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [A.mint.toBase58(), mintAccount(A.dec, A.program)],
    [B.mint.toBase58(), mintAccount(B.dec, B.program)],
    [
      nftAccount.toBase58(),
      tokenAccount(nftMint, opts.nftHolder ?? creator.publicKey, 1n, TOKEN_2022_PROGRAM_ID),
    ],
  ])
  const quotePending = opts.inverted ? (opts.pending?.a ?? 0n) : (opts.pending?.b ?? 0n)
  const me = creator.publicKey.toBase58()
  const authority = derivePoolAuthority().toBase58()
  const defaultMeta = (): { pre: Bal[]; post: Bal[] } => ({
    // CREATOR's PUMP account + the pool's PUMP vault; SCRATCHY untouched (OnlyB)
    pre: [
      { owner: me, mint: PUMP.toBase58(), amount: 50_000n, accountIndex: 1 },
      { owner: me, mint: SCRATCHY.toBase58(), amount: 1_000n, accountIndex: 2 },
      { owner: authority, mint: PUMP.toBase58(), amount: 222_000n, accountIndex: 3 },
    ],
    post: [
      { owner: me, mint: PUMP.toBase58(), amount: 50_000n + quotePending, accountIndex: 1 },
      { owner: me, mint: SCRATCHY.toBase58(), amount: 1_000n, accountIndex: 2 },
      { owner: authority, mint: PUMP.toBase58(), amount: 222_000n - quotePending, accountIndex: 3 },
    ],
  })
  const txLookups: Array<{ sig: string; cfg: unknown }> = []
  // no getTokenAccountsByOwner / balance reads on purpose: the claim must be measured from its tx meta
  const connection = {
    getAccountInfo: async (k: PublicKey) => accounts.get(k.toBase58()) ?? null,
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({
      context: { slot: 4242 },
      value: keys.map((k) =>
        tokenAccount(PUMP, pool, vaultAmounts.get(k.toBase58()) ?? 0n, TOKEN_PROGRAM_ID),
      ),
    }),
    getTransaction: async (sig: string, cfg: unknown) => {
      txLookups.push({ sig, cfg })
      if (sig !== 'claim-1') return null
      const m = opts.claimMeta ? opts.claimMeta(me) : defaultMeta()
      return m ? txResponse(m) : null
    },
  } as unknown as Connection
  const claimCalls: Array<Record<string, unknown>> = []
  const cpAmm = {
    fetchPoolState: async () => poolState,
    fetchPositionState: async () => positionState,
    getUserPositionByPool: async () =>
      opts.nftMoved ? [{ positionNftAccount: nftAccount, position, positionState }] : [],
    claimPositionFee2: async (p: Record<string, unknown>) => {
      claimCalls.push(p)
      return new Transaction()
    },
  } as unknown as CpAmmLike
  const venue = new DammV2Venue({
    connection,
    creator,
    pool,
    position,
    baseMint: SCRATCHY,
    quoteMint: PUMP,
    cpAmm,
    deltaOptions: { attempts: 3, sleep: noSleep },
    send: async (_tx, signers) => {
      expect(signers).toEqual([creator])
      return { signature: 'claim-1', slot: 777 }
    },
  })
  return { venue, creator, pool, position, nftMint, nftAccount, poolState, claimCalls, txLookups }
}

describe('DammV2Venue (faked SDK + RPC)', () => {
  it('reports pool state with exact sqrtPrice price, mapped reserves/decimals, and the vault-read slot', async () => {
    for (const inverted of [false, true]) {
      const f = venueFixture({ inverted })
      const s = await f.venue.getPoolState()
      expect(s.baseMint).toBe(SCRATCHY.toBase58())
      expect(s.quoteMint).toBe(PUMP.toBase58())
      expect(s.baseDecimals).toBe(9)
      expect(s.quoteDecimals).toBe(6)
      // vault A holds 111_000, vault B 222_000
      expect(s.baseReserveRaw).toBe(inverted ? 222_000n : 111_000n)
      expect(s.quoteReserveRaw).toBe(inverted ? 111_000n : 222_000n)
      const want = decimalToScaled('0.0125', 18)
      const err =
        s.priceQuotePerBaseE18 > want ? s.priceQuotePerBaseE18 - want : want - s.priceQuotePerBaseE18
      expect(err * 10n ** 12n <= want).toBe(true)
      expect(s.slot).toBe(4242)
    }
  })

  it('excludes pool, vaults, position, position NFT account and pool authority', async () => {
    const f = venueFixture({})
    const before = f.venue.excludedAddresses()
    expect(before).toContain(f.pool.toBase58())
    expect(before).toContain(f.position.toBase58())
    expect(before).toContain(derivePoolAuthority().toBase58())
    expect(before).toContain(f.poolState.tokenAVault.toBase58()) // derived PDA before init
    await f.venue.init()
    const after = f.venue.excludedAddresses()
    for (const k of [
      f.pool,
      f.position,
      derivePoolAuthority(),
      f.poolState.tokenAVault,
      f.poolState.tokenBVault,
    ]) {
      expect(after).toContain(k.toBase58())
    }
    expect(after).toContain(derivePositionNftAccount(f.nftMint).toBase58())
    expect(new Set(after).size).toBe(after.length)
  })

  it('reports the creator liquidity share from unlocked + vested + permanent-locked liquidity', async () => {
    const f = venueFixture({})
    expect(await f.venue.creatorLiquidityShare()).toBe(0.25) // (1 + 2 + 7) / 40
  })

  it("claims with claimPositionFee2 and books the PUMP delta from the claim tx's own meta", async () => {
    const f = venueFixture({ pending: { a: 0n, b: 9_876n } })
    expect(await f.venue.pendingFees()).toEqual({ quoteRaw: 9_876n, baseRaw: 0n })
    const r = await f.venue.claimFees()
    expect(r).toEqual({ signatures: ['claim-1'], claimedQuoteRaw: 9_876n, claimedBaseRaw: 0n })
    expect(f.claimCalls).toHaveLength(1)
    const c = f.claimCalls[0]!
    expect((c.owner as PublicKey).equals(f.creator.publicKey)).toBe(true)
    expect((c.receiver as PublicKey).equals(f.creator.publicKey)).toBe(true)
    expect((c.feePayer as PublicKey).equals(f.creator.publicKey)).toBe(true)
    expect((c.positionNftAccount as PublicKey).equals(derivePositionNftAccount(f.nftMint))).toBe(true)
    expect((c.tokenAProgram as PublicKey).equals(TOKEN_PROGRAM_ID)).toBe(true)
    expect((c.tokenBProgram as PublicKey).equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
    expect(f.txLookups).toEqual([
      { sig: 'claim-1', cfg: { commitment: 'confirmed', maxSupportedTransactionVersion: 0 } },
    ])
  })

  it('books the measured amount even when it differs from the pending estimate', async () => {
    const f = venueFixture({
      pending: { a: 0n, b: 9_876n },
      claimMeta: (me) => ({
        pre: [{ owner: me, mint: PUMP.toBase58(), amount: 10n }],
        post: [
          { owner: me, mint: PUMP.toBase58(), amount: 10n + 9_000n, accountIndex: 0 },
          { owner: me, mint: SCRATCHY.toBase58(), amount: 3n, accountIndex: 1 }, // SCRATCHY ATA created
        ],
      }),
    })
    expect(await f.venue.claimFees()).toEqual({
      signatures: ['claim-1'],
      claimedQuoteRaw: 9_000n,
      claimedBaseRaw: 3n,
    })
  })

  it('maps fees correctly for an inverted pool', async () => {
    const f = venueFixture({ inverted: true, pending: { a: 1_234n, b: 0n } })
    expect(await f.venue.pendingFees()).toEqual({ quoteRaw: 1_234n, baseRaw: 0n })
    expect(await f.venue.claimFees()).toMatchObject({ claimedQuoteRaw: 1_234n, claimedBaseRaw: 0n })
  })

  it("finds CREATOR's position NFT outside the PDA account and claims with it", async () => {
    const f = venueFixture({ nftMoved: true, pending: { a: 0n, b: 5n } })
    await f.venue.init()
    expect(f.venue.excludedAddresses()).toContain(f.nftAccount.toBase58())
    expect(await f.venue.claimFees()).toMatchObject({ claimedQuoteRaw: 5n })
    expect((f.claimCalls[0]!.positionNftAccount as PublicKey).equals(f.nftAccount)).toBe(true)
  })

  it('does not send (or look anything up) when nothing is pending', async () => {
    const f = venueFixture({})
    expect(await f.venue.claimFees()).toEqual({ signatures: [], claimedQuoteRaw: 0n, claimedBaseRaw: 0n })
    expect(f.claimCalls).toHaveLength(0)
    expect(f.txLookups).toHaveLength(0)
  })

  it('throws with the claim signature on a negative delta or when the claim tx meta never shows up', async () => {
    const neg = venueFixture({
      pending: { a: 0n, b: 5n },
      claimMeta: (me) => ({
        pre: [{ owner: me, mint: PUMP.toBase58(), amount: 100n }],
        post: [{ owner: me, mint: PUMP.toBase58(), amount: 90n }],
      }),
    })
    await expect(neg.venue.claimFees()).rejects.toMatchObject({
      name: 'ClaimMeasurementError',
      signatures: ['claim-1'],
      signature: 'claim-1',
    })
    const missing = venueFixture({ pending: { a: 0n, b: 5n }, claimMeta: () => null })
    await expect(missing.venue.claimFees()).rejects.toMatchObject({
      name: 'ClaimMeasurementError',
      signature: 'claim-1',
    })
    expect(missing.txLookups).toHaveLength(3) // retried per deltaOptions.attempts
  })

  it('refuses a position from another pool or whose NFT CREATOR does not hold', async () => {
    await expect(venueFixture({ positionPool: Keypair.generate().publicKey }).venue.init()).rejects.toThrow(
      /belongs to pool/,
    )
    await expect(venueFixture({ nftHolder: Keypair.generate().publicKey }).venue.init()).rejects.toThrow(
      /does not hold the NFT/,
    )
  })
})

// ── fake RPC for sign → send → confirm → getTransaction ──────────────────────

type Status = { slot: number; err: unknown; confirmationStatus: string } | null

function fakeRpc(p: {
  /** successive non-history status answers (the last one repeats); default: confirmed at slot 7 */
  statuses?: Status[]
  history?: Status
  historyContextSlot?: number
  finalizedHeight?: number
  finalizedSlot?: number
  sendThrows?: Error
  /** getTransaction answer for a signature */
  tx?: (sig: string, call: number) => unknown
  events?: string[]
  accounts?: Map<string, AccountInfo<Buffer>>
}) {
  const sends: Array<{ raw: Uint8Array; skipPreflight?: boolean }> = []
  const events = p.events ?? []
  let i = 0
  let txCalls = 0
  const statuses = p.statuses ?? [{ slot: 7, err: null, confirmationStatus: 'confirmed' }]
  const conn = {
    getLatestBlockhash: async () => ({
      blockhash: bs58.encode(Buffer.alloc(32, 9)),
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: async (raw: Uint8Array, o?: { skipPreflight?: boolean }) => {
      events.push('send')
      sends.push({ raw: Uint8Array.from(raw), skipPreflight: o?.skipPreflight })
      if (p.sendThrows && sends.length === 1) throw p.sendThrows
      return 'ignored'
    },
    getSignatureStatuses: async (_sigs: string[], cfg?: { searchTransactionHistory?: boolean }) =>
      cfg?.searchTransactionHistory
        ? { context: { slot: p.historyContextSlot ?? 1 }, value: [p.history ?? null] }
        : { context: { slot: 1 }, value: [statuses[Math.min(i++, statuses.length - 1)] ?? null] },
    getEpochInfo: async () => ({
      epoch: 1,
      slotIndex: 0,
      slotsInEpoch: 432_000,
      absoluteSlot: p.finalizedSlot ?? 1,
      blockHeight: p.finalizedHeight ?? 50,
    }),
    getTransaction: async (sig: string) => {
      events.push('getTransaction')
      return p.tx ? (p.tx(sig, ++txCalls) ?? null) : null
    },
    getSlot: async () => 1_000,
    getBlockTime: async () => 1_700_000_000,
    getAccountInfo: async (k: PublicKey) => p.accounts?.get(k.toBase58()) ?? null,
  }
  return { conn: conn as unknown as Connection & VenueSendConnection, sends, events }
}

const firstSig = (raw: Uint8Array) => bs58.encode(Transaction.from(raw).signature!)

// ── DAMM pool swap ───────────────────────────────────────────────────────────

function dammSwapHarness(p: {
  /** swap tx meta as a function of the signature; default: exactly 1_000_000 in, 99_990 out */
  tx?: (sig: string, call: number) => unknown
  statuses?: Status[]
  sendThrows?: Error
  quoteOut?: number
}) {
  const owner = Keypair.generate()
  const pool = Keypair.generate().publicKey
  const poolState = fakePoolState(
    {
      tokenAMint: SCRATCHY,
      tokenBMint: PUMP,
      tokenAFlag: 1,
      tokenBFlag: 1,
      sqrtPrice: X64,
      liquidity: X64,
    },
    pool,
  )
  const accounts = new Map([
    [SCRATCHY.toBase58(), mintAccount(6, TOKEN_2022_PROGRAM_ID)],
    [PUMP.toBase58(), mintAccount(6, TOKEN_2022_PROGRAM_ID)],
  ])
  const events: string[] = []
  const me = owner.publicKey.toBase58()
  const rpc = fakeRpc({
    events,
    accounts,
    statuses: p.statuses,
    sendThrows: p.sendThrows,
    tx: p.tx ?? (() => swapTxResponse(me, SCRATCHY.toBase58(), PUMP.toBase58(), 1_000_000n, 99_990n)),
  })
  const quoteCalls: Array<Record<string, unknown>> = []
  const swapCalls: Array<Record<string, unknown>> = []
  const cpAmm = {
    fetchPoolState: async () => poolState,
    getQuote: (q: Record<string, unknown>) => {
      quoteCalls.push(q)
      return { swapOutAmount: new BN(p.quoteOut ?? 99_999), minSwapOutAmount: new BN(0) }
    },
    swap2: async (s: Record<string, unknown>) => {
      swapCalls.push(s)
      return new Transaction().add(
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: pool, lamports: 1 }),
      )
    },
  } as unknown as CpAmmLike
  const swap = new DammPoolSwap({
    connection: rpc.conn,
    owner,
    pool,
    baseMint: SCRATCHY,
    quoteMint: PUMP,
    cpAmm,
    sendOptions: { sleep: noSleep, pollMs: 0, resendMs: 0 },
    deltaOptions: { attempts: 3, sleep: noSleep },
  })
  const signedCalls: Array<{ signature: string; lastValidBlockHeight: number }> = []
  const onSigned: OnSwapSigned = async (s) => {
    events.push('onSigned')
    signedCalls.push(s)
  }
  return { swap, owner, rpc, events, quoteCalls, swapCalls, onSigned, signedCalls, me }
}

describe('DammPoolSwap', () => {
  it('quotes in bps, swaps ExactIn with our floor, signs → onSigned → sends, books in/out from tx meta', async () => {
    const h = dammSwapHarness({})
    await expect(h.swap.swapBaseToQuote(0n, 300)).rejects.toThrow(/> 0/)
    await expect(h.swap.swapBaseToQuote(-5n, 300)).rejects.toThrow(/> 0/)
    await expect(h.swap.swapBaseToQuote(1n, 10_000)).rejects.toThrow(/maxSlippageBps/)

    const r = await h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
    const sig = h.signedCalls[0]!.signature
    expect(r).toEqual({ signature: sig, inRaw: 1_000_000n, outRaw: 99_990n })
    // the signature handed to onSigned is the one broadcast, and nothing was broadcast before it
    expect(h.events.slice(0, 2)).toEqual(['onSigned', 'send'])
    expect(h.signedCalls).toEqual([{ signature: sig, lastValidBlockHeight: 100 }])
    expect(h.rpc.sends.length).toBeGreaterThan(0)
    for (const s of h.rpc.sends) expect(firstSig(s.raw)).toBe(sig) // identical bytes on every broadcast
    expect(h.rpc.sends[0]!.skipPreflight).toBe(false)

    expect(h.quoteCalls[0]!.slippage).toBe(300) // SDK 1.5.0 takes basis points
    expect((h.quoteCalls[0]!.inputTokenMint as PublicKey).equals(SCRATCHY)).toBe(true)
    expect(h.quoteCalls[0]!.currentSlot).toBe(1_000)
    const s = h.swapCalls[0]!
    expect((s.inputTokenMint as PublicKey).equals(SCRATCHY)).toBe(true)
    expect((s.outputTokenMint as PublicKey).equals(PUMP)).toBe(true)
    expect(s.swapMode).toBe(0) // ExactIn
    expect((s.amountIn as BN).toString()).toBe('1000000')
    expect((s.minimumAmountOut as BN).toString()).toBe('96999') // floor(99_999 × 0.97)
  })

  it('works without onSigned (optional)', async () => {
    const h = dammSwapHarness({})
    expect(await h.swap.swapBaseToQuote(1_000_000n, 300)).toMatchObject({
      inRaw: 1_000_000n,
      outRaw: 99_990n,
    })
  })

  it('never sends when onSigned throws', async () => {
    const h = dammSwapHarness({})
    const boom = new Error('db down')
    await expect(
      h.swap.swapBaseToQuote(1_000_000n, 300, async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(h.rpc.sends).toHaveLength(0)
    expect(h.events).not.toContain('send')
  })

  it('an on-chain failure after sending carries the signature', async () => {
    const h = dammSwapHarness({
      statuses: [
        { slot: 9, err: { InstructionError: [2, { Custom: 6004 }] }, confirmationStatus: 'confirmed' },
      ],
    })
    const p = h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
    await expect(p).rejects.toBeInstanceOf(VenueTxError)
    await expect(p).rejects.toMatchObject({ failure: 'onchain', signature: h.signedCalls[0]?.signature })
  })

  it('a preflight rejection carries the signature too (it may exist on another node)', async () => {
    const h = dammSwapHarness({
      sendThrows: new SendTransactionError({
        action: 'send',
        signature: 'x',
        transactionMessage: 'Blockhash not found',
        logs: [],
      }),
    })
    const p = h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
    await expect(p).rejects.toMatchObject({ failure: 'preflight' })
    await expect(p).rejects.toMatchObject({ signature: h.signedCalls[0]!.signature })
  })

  it('refuses to book a tx whose meta differs from what was signed (with the signature)', async () => {
    for (const [inRaw, outRaw, re] of [
      [900_000n, 99_990n, /signed for exactly/],
      [1_000_000n, 96_998n, /signed minimum/],
    ] as const) {
      const h = dammSwapHarness({
        tx: () => swapTxResponse(h.me, SCRATCHY.toBase58(), PUMP.toBase58(), inRaw, outRaw),
      })
      const p = h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
      await expect(p).rejects.toThrow(re)
      await expect(p).rejects.toMatchObject({
        failure: 'measurement',
        signature: h.signedCalls[0]!.signature,
      })
    }
  })

  it('retries a lagging getTransaction and throws with the signature if the tx never shows up', async () => {
    const lag = dammSwapHarness({
      tx: (_sig, call) =>
        call < 3 ? null : swapTxResponse(lag.me, SCRATCHY.toBase58(), PUMP.toBase58(), 1_000_000n, 99_990n),
    })
    expect(await lag.swap.swapBaseToQuote(1_000_000n, 300)).toMatchObject({ outRaw: 99_990n })

    const never = dammSwapHarness({ tx: () => null })
    const p = never.swap.swapBaseToQuote(1_000_000n, 300, never.onSigned)
    await expect(p).rejects.toThrow(/not returned by getTransaction/)
    await expect(p).rejects.toMatchObject({
      failure: 'measurement',
      signature: never.signedCalls[0]!.signature,
    })
  })

  it('refuses a quote whose slippage floor rounds to zero, before signing', async () => {
    const h = dammSwapHarness({ quoteOut: 1 })
    await expect(h.swap.swapBaseToQuote(10n, 300, h.onSigned)).rejects.toThrow(/rounds to 0/)
    expect(h.signedCalls).toHaveLength(0)
    expect(h.rpc.sends).toHaveLength(0)
  })
})

// ── NoSwap + slippage math ───────────────────────────────────────────────────

describe('NoSwap', () => {
  it('returns zeros for 0 and refuses any real amount, never calling onSigned', async () => {
    const n = new NoSwap()
    let signed = 0
    const onSigned: OnSwapSigned = async () => {
      signed++
    }
    expect(n.name).toBe('none')
    expect(await n.swapBaseToQuote(0n, 300, onSigned)).toEqual({ signature: '', inRaw: 0n, outRaw: 0n })
    await expect(n.swapBaseToQuote(1n, 300, onSigned)).rejects.toThrow(/OnlyB/)
    expect(signed).toBe(0)
  })
})

describe('minOutWithSlippage', () => {
  it('floors out × (10000 − bps) / 10000 and validates bps', () => {
    expect(minOutWithSlippage(10_000n, 300)).toBe(9_700n)
    expect(minOutWithSlippage(999n, 300)).toBe(969n)
    expect(minOutWithSlippage(5n, 0)).toBe(5n)
    expect(() => minOutWithSlippage(5n, 10_000)).toThrow()
    expect(() => minOutWithSlippage(5n, 1.5)).toThrow()
    expect(() => minOutWithSlippage(5n, -1)).toThrow()
  })
})

// ── Jupiter Swap v2 ──────────────────────────────────────────────────────────

const JUP_IN = SCRATCHY.toBase58()
const JUP_OUT = PUMP.toBase58()

function unsignedV0(payer: PublicKey, extraSigner?: PublicKey): string {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: extraSigner ?? payer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message()
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64')
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function jupiterHarness(p: {
  owner?: Keypair
  apiKey?: string
  order?: Record<string, unknown> | ((owner: Keypair) => Record<string, unknown>)
  orderStatus?: number
  execute?: (signedTx: VersionedTransaction) => Record<string, unknown>
  executeStatus?: number
  rpcStatus?: { err: unknown; confirmationStatus: string } | null
  /** swap tx meta (default: exactly 1_000_000 SCRATCHY in, 49_876 PUMP out) */
  tx?: (owner: string) => unknown
  blockhashThrows?: boolean
}) {
  const owner = p.owner ?? Keypair.generate()
  const calls: Call[] = []
  const events: string[] = []
  const defaultOrder = {
    transaction: unsignedV0(owner.publicKey),
    requestId: 'req-1',
    inputMint: JUP_IN,
    outputMint: JUP_OUT,
    inAmount: '1000000',
    outAmount: '50000',
    otherAmountThreshold: '48500',
    swapMode: 'ExactIn',
    slippageBps: 300,
    gasless: false,
  }
  const fetchImpl: FetchFn = async (url, init) => {
    calls.push({ url, init })
    if (url.includes('/swap/v2/order')) {
      const o = typeof p.order === 'function' ? p.order(owner) : { ...defaultOrder, ...(p.order ?? {}) }
      return new Response(JSON.stringify(o), { status: p.orderStatus ?? 200 })
    }
    events.push('execute')
    const body = JSON.parse(String(init?.body)) as { signedTransaction: string }
    const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, 'base64'))
    const res = p.execute
      ? p.execute(tx)
      : {
          status: 'Success',
          signature: bs58.encode(tx.signatures[0]!),
          // deliberately wrong: in/out must come from the tx meta, never from execute's totals
          totalInputAmount: '1',
          totalOutputAmount: '999999999',
        }
    return new Response(JSON.stringify(res), { status: p.executeStatus ?? 200 })
  }
  const me = owner.publicKey.toBase58()
  const txLookups: string[] = []
  const connection = {
    getSignatureStatuses: async () => ({
      context: { slot: 1 },
      value: [
        p.rpcStatus === undefined
          ? { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' }
          : p.rpcStatus,
      ],
    }),
    getLatestBlockhash: async () => {
      if (p.blockhashThrows) throw new Error('rpc down')
      return { blockhash: bs58.encode(Buffer.alloc(32, 3)), lastValidBlockHeight: 1_000 }
    },
    getTransaction: async (sig: string) => {
      txLookups.push(sig)
      return p.tx ? p.tx(me) : swapTxResponse(me, JUP_IN, JUP_OUT, 1_000_000n, 49_876n)
    },
  } as unknown as Connection
  const swap = new JupiterSwap({
    connection,
    owner,
    base: 'https://api.jup.test/',
    apiKey: p.apiKey,
    fetchImpl,
    inputMint: JUP_IN,
    outputMint: JUP_OUT,
    confirmPolls: 3,
    sleep: noSleep,
    deltaOptions: { attempts: 2, sleep: noSleep },
  })
  const signedCalls: Array<{ signature: string; lastValidBlockHeight: number }> = []
  const onSigned: OnSwapSigned = async (s) => {
    events.push('onSigned')
    signedCalls.push(s)
  }
  return { swap, calls, owner, defaultOrder, events, onSigned, signedCalls, txLookups }
}

describe('JupiterSwap', () => {
  it('builds /order with explicit slippageBps + taker, signs → onSigned → /execute, books from tx meta', async () => {
    const h = jupiterHarness({ apiKey: 'secret-key' })
    const r = await h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
    expect(h.calls).toHaveLength(2)

    const order = new URL(h.calls[0]!.url)
    expect(order.origin + order.pathname).toBe('https://api.jup.test/swap/v2/order')
    expect(Object.fromEntries(order.searchParams)).toEqual({
      inputMint: JUP_IN,
      outputMint: JUP_OUT,
      amount: '1000000',
      taker: h.owner.publicKey.toBase58(),
      slippageBps: '300',
    })
    expect(h.calls[0]!.init?.method).toBe('GET')
    expect((h.calls[0]!.init?.headers as Record<string, string>)['x-api-key']).toBe('secret-key')

    const exec = h.calls[1]!
    expect(exec.url).toBe('https://api.jup.test/swap/v2/execute')
    expect(exec.init?.method).toBe('POST')
    expect((exec.init?.headers as Record<string, string>)['x-api-key']).toBe('secret-key')
    const body = JSON.parse(String(exec.init?.body)) as { signedTransaction: string; requestId: string }
    expect(body.requestId).toBe('req-1')
    // ed25519 is deterministic: re-signing the unsigned order tx must reproduce the posted signature
    const expected = VersionedTransaction.deserialize(Buffer.from(h.defaultOrder.transaction, 'base64'))
    expected.sign([h.owner])
    const sig = bs58.encode(expected.signatures[0]!)
    const posted = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, 'base64'))
    expect(bs58.encode(posted.signatures[0]!)).toBe(sig)

    // onSigned got OUR signature (= the tx id) before anything was executed
    expect(h.events).toEqual(['onSigned', 'execute'])
    expect(h.signedCalls).toEqual([
      { signature: sig, lastValidBlockHeight: 1_000 + JUPITER_EXPIRY_MARGIN_BLOCKS },
    ])
    // in/out from the confirmed tx's meta, not execute's (bogus) totals
    expect(r).toEqual({ signature: sig, inRaw: 1_000_000n, outRaw: 49_876n })
    expect(h.txLookups).toEqual([sig])
  })

  it("uses the order's own lastValidBlockHeight when it is later, and refuses when none is known", async () => {
    const later = jupiterHarness({ order: { lastValidBlockHeight: 5_000 } })
    await later.swap.swapBaseToQuote(1_000_000n, 300, later.onSigned)
    expect(later.signedCalls[0]!.lastValidBlockHeight).toBe(5_000)

    const orderOnly = jupiterHarness({ order: { lastValidBlockHeight: '777' }, blockhashThrows: true })
    await orderOnly.swap.swapBaseToQuote(1_000_000n, 300, orderOnly.onSigned)
    expect(orderOnly.signedCalls[0]!.lastValidBlockHeight).toBe(777)

    const none = jupiterHarness({ blockhashThrows: true })
    await expect(none.swap.swapBaseToQuote(1_000_000n, 300, none.onSigned)).rejects.toThrow(
      /lastValidBlockHeight/,
    )
    expect(none.signedCalls).toHaveLength(0)
    expect(none.calls).toHaveLength(1) // /execute never reached
  })

  it('never calls /execute when onSigned throws', async () => {
    const h = jupiterHarness({})
    const boom = new Error('db down')
    await expect(
      h.swap.swapBaseToQuote(1_000_000n, 300, async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    expect(h.calls).toHaveLength(1)
    expect(h.events).toEqual([])
  })

  it('sends no x-api-key header without a key', async () => {
    const h = jupiterHarness({})
    await h.swap.swapBaseToQuote(1_000_000n, 300)
    for (const c of h.calls) expect((c.init?.headers as Record<string, string>)['x-api-key']).toBeUndefined()
  })

  it('refuses bad amounts / slippage without any request', async () => {
    const h = jupiterHarness({})
    await expect(h.swap.swapBaseToQuote(0n, 300)).rejects.toThrow(RangeError)
    await expect(h.swap.swapBaseToQuote(1n, 20_000)).rejects.toThrow(RangeError)
    expect(h.calls).toHaveLength(0)
  })

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      'errorCode',
      { errorCode: 1, errorMessage: 'Insufficient funds', transaction: '' },
      /errorCode=1.*Insufficient funds/,
    ],
    ['empty transaction', { transaction: '' }, /no transaction/],
    ['null transaction', { transaction: null }, /no transaction/],
    ['wrong input mint', { inputMint: JUP_OUT }, /mints mismatch/],
    ['wrong output mint', { outputMint: Keypair.generate().publicKey.toBase58() }, /mints mismatch/],
    ['wrong amount', { inAmount: '999999' }, /inAmount/],
    ['missing amount', { inAmount: undefined }, /inAmount/],
    ['ExactOut', { swapMode: 'ExactOut' }, /swapMode/],
    ['looser slippage', { slippageBps: 500 }, /slippageBps/],
    ['loose minimum-out', { otherAmountThreshold: '48499' }, /looser/],
    ['zero output', { outAmount: '0', otherAmountThreshold: '0' }, /no output/],
    ['no requestId', { requestId: '' }, /requestId/],
    ['gasless flag', { gasless: true }, /gasless/],
    [
      'sponsored signature fee',
      { signatureFeePayer: Keypair.generate().publicKey.toBase58() },
      /not the taker/,
    ],
  ]
  for (const [name, patch, re] of refusals) {
    it(`refuses to sign an order with ${name}`, async () => {
      const h = jupiterHarness({ order: patch })
      await expect(h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)).rejects.toThrow(re)
      expect(h.calls).toHaveLength(1) // /execute never reached
      expect(h.signedCalls).toHaveLength(0)
    })
  }

  it('refuses a transaction that does not need the taker signature', async () => {
    const other = Keypair.generate().publicKey
    const h = jupiterHarness({
      order: (owner) => ({
        transaction: unsignedV0(other),
        requestId: 'r',
        inputMint: JUP_IN,
        outputMint: JUP_OUT,
        inAmount: '1000000',
        outAmount: '50000',
        otherAmountThreshold: '49000',
        _owner: owner.publicKey.toBase58(),
      }),
    })
    await expect(h.swap.swapBaseToQuote(1_000_000n, 300)).rejects.toThrow(/does not require the taker/)
    expect(h.calls).toHaveLength(1)
  })

  it('refuses a gasless transaction whose fee payer is not the taker (even without a gasless flag)', async () => {
    const sponsor = Keypair.generate().publicKey
    const h = jupiterHarness({
      order: (owner) => ({
        transaction: unsignedV0(sponsor, owner.publicKey), // taker signs, sponsor pays → sponsor's sig is the id
        requestId: 'r',
        inputMint: JUP_IN,
        outputMint: JUP_OUT,
        inAmount: '1000000',
        outAmount: '50000',
        otherAmountThreshold: '49000',
      }),
    })
    await expect(h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)).rejects.toThrow(
      /fee payer .* is not the taker/,
    )
    expect(h.calls).toHaveLength(1)
    expect(h.signedCalls).toHaveLength(0)
  })

  it('surfaces order HTTP errors with the status (nothing signed)', async () => {
    const h = jupiterHarness({ orderStatus: 500, order: { error: 'upstream down' } })
    await expect(h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)).rejects.toThrow(
      /HTTP 500.*upstream down/,
    )
    expect(h.signedCalls).toHaveLength(0)
  })

  it('throws on execute Failed, carrying our signature', async () => {
    const h = jupiterHarness({
      execute: (tx) => ({
        status: 'Failed',
        code: -1005,
        error: 'slippage',
        signature: bs58.encode(tx.signatures[0]!),
      }),
    })
    const p = h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
    await expect(p).rejects.toBeInstanceOf(JupiterSwapError)
    await expect(p).rejects.toThrow(/Failed.*-1005.*slippage/)
    await expect(p).rejects.toMatchObject({ signature: h.signedCalls[0]!.signature })
  })

  it('an /execute HTTP error or timeout still carries our signature (it may have been submitted)', async () => {
    const h = jupiterHarness({ executeStatus: 502, execute: () => ({ error: 'bad gateway' }) })
    const p = h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
    await expect(p).rejects.toBeInstanceOf(JupiterSwapError)
    await expect(p).rejects.toThrow(/HTTP 502/)
    await expect(p).rejects.toMatchObject({ signature: h.signedCalls[0]!.signature })
  })

  it('rejects a Success for a different signature than the one we signed', async () => {
    const h = jupiterHarness({
      execute: () => ({ status: 'Success', signature: bs58.encode(Buffer.alloc(64, 1)) }),
    })
    const p = h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
    await expect(p).rejects.toThrow(/≠ the transaction we signed/)
    await expect(p).rejects.toMatchObject({ signature: h.signedCalls[0]!.signature })
  })

  it('accepts a Success without a signature field (ours is the tx id)', async () => {
    const h = jupiterHarness({ execute: () => ({ status: 'Success' }) })
    const r = await h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
    expect(r.signature).toBe(h.signedCalls[0]!.signature)
  })

  it('checks the signature on our own RPC after Success (errors carry the signature)', async () => {
    const failed = jupiterHarness({
      rpcStatus: { err: { InstructionError: [2, 'Custom'] }, confirmationStatus: 'confirmed' },
    })
    const p1 = failed.swap.swapBaseToQuote(1_000_000n, 300, failed.onSigned)
    await expect(p1).rejects.toThrow(/failed on-chain/)
    await expect(p1).rejects.toMatchObject({ signature: failed.signedCalls[0]!.signature })
    const unseen = jupiterHarness({ rpcStatus: null })
    const p2 = unseen.swap.swapBaseToQuote(1_000_000n, 300, unseen.onSigned)
    await expect(p2).rejects.toThrow(/hasn't confirmed/)
    await expect(p2).rejects.toMatchObject({ signature: unseen.signedCalls[0]!.signature })
    expect(unseen.txLookups).toHaveLength(0)
  })

  it('refuses to book a tx whose meta differs from the order (with the signature)', async () => {
    for (const [inRaw, outRaw, re] of [
      [999_999n, 49_876n, /signed for exactly/],
      [1_000_000n, 48_499n, /signed minimum/], // below otherAmountThreshold 48_500
    ] as const) {
      const h = jupiterHarness({ tx: (me) => swapTxResponse(me, JUP_IN, JUP_OUT, inRaw, outRaw) })
      const p = h.swap.swapBaseToQuote(1_000_000n, 300, h.onSigned)
      await expect(p).rejects.toBeInstanceOf(JupiterSwapError)
      await expect(p).rejects.toThrow(re)
      await expect(p).rejects.toMatchObject({ signature: h.signedCalls[0]!.signature })
    }
    const missing = jupiterHarness({ tx: () => null })
    const p = missing.swap.swapBaseToQuote(1_000_000n, 300, missing.onSigned)
    await expect(p).rejects.toThrow(/not returned by getTransaction/)
    await expect(p).rejects.toMatchObject({ signature: missing.signedCalls[0]!.signature })
  })
})

// ── sign / send / confirm ────────────────────────────────────────────────────

function legacyTx(payer: Keypair): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  )
}

describe('signWithFreshBlockhash + sendSignedAndConfirm', () => {
  const fast = { sleep: noSleep, pollMs: 0, resendMs: 0 }

  it('signs without sending, then broadcasts exactly those bytes (never re-signed)', async () => {
    const payer = Keypair.generate()
    const { conn, sends } = fakeRpc({
      statuses: [null, null, { slot: 7, err: null, confirmationStatus: 'confirmed' }],
    })
    const tx = legacyTx(payer)
    const signed = await signWithFreshBlockhash(conn, tx, [payer])
    expect(sends).toHaveLength(0)
    expect(signed.signature).toBe(bs58.encode(tx.signature!))
    expect(signed.blockhash).toBe(bs58.encode(Buffer.alloc(32, 9)))
    expect(signed.lastValidBlockHeight).toBe(100)
    expect(firstSig(signed.bytes)).toBe(signed.signature)

    const res = await sendSignedAndConfirm(conn, signed, fast)
    expect(res).toEqual({ signature: signed.signature, slot: 7 })
    expect(sends.length).toBeGreaterThanOrEqual(2)
    for (const s of sends) expect(Buffer.from(s.raw).equals(Buffer.from(signed.bytes))).toBe(true)
  })

  it('does not declare expiry from a history view older than the finalized-height view', async () => {
    const payer = Keypair.generate()
    let t = 0
    const { conn } = fakeRpc({
      statuses: [null],
      finalizedHeight: 101,
      finalizedSlot: 500,
      history: null,
      historyContextSlot: 499, // lagging node: its "not found" proves nothing
    })
    const signed = await signWithFreshBlockhash(conn, legacyTx(payer), [payer])
    await expect(
      sendSignedAndConfirm(conn, signed, { ...fast, timeoutMs: 5, now: () => (t += 2) }),
    ).rejects.toMatchObject({ failure: 'timeout', signature: signed.signature })
    // …but the same "not found" from a view at/after that slot is a proof
    const fresh = fakeRpc({
      statuses: [null],
      finalizedHeight: 101,
      finalizedSlot: 500,
      history: null,
      historyContextSlot: 500,
    })
    await expect(sendSignedAndConfirm(fresh.conn, signed, fast)).rejects.toMatchObject({
      failure: 'expired',
      signature: signed.signature,
    })
  })
})

describe('sendAndConfirmSigned', () => {
  const fast = { sleep: noSleep, pollMs: 0, resendMs: 0 }

  it('signs with a fresh blockhash, sends with preflight, rebroadcasts, and returns the fee payer signature', async () => {
    const payer = Keypair.generate()
    const { conn, sends } = fakeRpc({
      statuses: [
        null,
        { slot: 7, err: null, confirmationStatus: 'processed' },
        { slot: 7, err: null, confirmationStatus: 'confirmed' },
      ],
    })
    const tx = legacyTx(payer)
    const sig = await sendAndConfirmSigned(conn, tx, [payer], fast)
    expect(sig).toBe(bs58.encode(tx.signature!))
    expect(tx.recentBlockhash).toBe(bs58.encode(Buffer.alloc(32, 9)))
    expect(sends[0]!.skipPreflight).toBe(false)
    expect(sends.slice(1).every((s) => s.skipPreflight === true)).toBe(true)
  })

  it('throws on an on-chain error', async () => {
    const payer = Keypair.generate()
    const { conn } = fakeRpc({
      statuses: [{ slot: 7, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }],
    })
    await expect(sendAndConfirmSigned(conn, legacyTx(payer), [payer], fast)).rejects.toMatchObject({
      failure: 'onchain',
    })
  })

  it('declares expiry only after finalized height passes lastValidBlockHeight and history is empty', async () => {
    const payer = Keypair.generate()
    const { conn } = fakeRpc({ statuses: [null], finalizedHeight: 101, history: null })
    const p = sendAndConfirmSigned(conn, legacyTx(payer), [payer], fast)
    await expect(p).rejects.toBeInstanceOf(VenueTxError)
    await expect(p).rejects.toMatchObject({ failure: 'expired' })
    // …but a late landing found in history is a success
    const late = fakeRpc({
      statuses: [null],
      finalizedHeight: 101,
      history: { slot: 99, err: null, confirmationStatus: 'finalized' },
    })
    await expect(sendAndConfirmSigned(late.conn, legacyTx(payer), [payer], fast)).resolves.toMatch(/.+/)
  })

  it('maps an RPC rejection (preflight) to a preflight failure', async () => {
    const payer = Keypair.generate()
    const { conn } = fakeRpc({
      statuses: [null],
      sendThrows: new SendTransactionError({
        action: 'send',
        signature: 'x',
        transactionMessage: 'Simulation failed',
        logs: ['Program log: boom'],
      }),
    })
    await expect(sendAndConfirmSigned(conn, legacyTx(payer), [payer], fast)).rejects.toMatchObject({
      failure: 'preflight',
    })
  })

  it('keeps polling through a transport error on the first send', async () => {
    const payer = Keypair.generate()
    const { conn } = fakeRpc({
      statuses: [{ slot: 3, err: null, confirmationStatus: 'confirmed' }],
      sendThrows: new Error('socket hang up'),
    })
    await expect(sendAndConfirmSigned(conn, legacyTx(payer), [payer], fast)).resolves.toMatch(/.+/)
  })

  it('gives up with a timeout when the outcome stays unknown', async () => {
    const payer = Keypair.generate()
    let t = 0
    const { conn } = fakeRpc({ statuses: [null] })
    await expect(
      sendAndConfirmSigned(conn, legacyTx(payer), [payer], { ...fast, timeoutMs: 5, now: () => (t += 2) }),
    ).rejects.toMatchObject({ failure: 'timeout' })
  })
})
