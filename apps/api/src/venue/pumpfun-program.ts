import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { pow10 } from '@scratchy/core'
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

/**
 * pump.fun program glue for the `pumpfun` venue (PLAN §3 fee sweeper): PDAs, account decoders and the two
 * instructions the sweeper sends. Pure — no network, no clock. Ported from cockfight's `packages/solana`
 * (verified on mainnet against a PUMP-quoted Custom Pair with "Share creator rewards"), rewritten on top of
 * web3.js so it plugs into the shared venue send/measure plumbing.
 *
 * How the money flows on a pump.fun Custom Pair (quote = PUMP, creator fee = 3%):
 *   trades → creator vault (bonding curve) / AMM creator vault (after graduation)
 *   → `distribute_creator_fees_v2` (permissionless) pays the sharing config's shareholders' PUMP accounts
 *     directly: PRIZE gets its share, OPS gets its share. There is no CREATOR hop and no split transfer.
 */

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
export const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
/** pump.fun migrates every graduated coin into PumpSwap pool index 0 owned by its pool authority PDA */
export const CANONICAL_POOL_INDEX = 0

const pda = (seeds: Uint8Array[], program: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => Buffer.from(s)),
    program,
  )[0]

export const pumpPda = {
  bondingCurve: (mint: PublicKey) => pda([utf8ToBytes('bonding-curve'), mint.toBytes()], PUMP_PROGRAM_ID),
  creatorVault: (creator: PublicKey) =>
    pda([utf8ToBytes('creator-vault'), creator.toBytes()], PUMP_PROGRAM_ID),
  eventAuthority: () => pda([utf8ToBytes('__event_authority')], PUMP_PROGRAM_ID),
  poolAuthority: (mint: PublicKey) => pda([utf8ToBytes('pool-authority'), mint.toBytes()], PUMP_PROGRAM_ID),
  sharingConfig: (mint: PublicKey) =>
    pda([utf8ToBytes('sharing-config'), mint.toBytes()], PUMP_FEES_PROGRAM_ID),
  ammCreatorVaultAuthority: (creator: PublicKey) =>
    pda([utf8ToBytes('creator_vault'), creator.toBytes()], PUMP_AMM_PROGRAM_ID),
  ammEventAuthority: () => pda([utf8ToBytes('__event_authority')], PUMP_AMM_PROGRAM_ID),
  ammPool: (index: number, owner: PublicKey, baseMint: PublicKey, quoteMint: PublicKey) => {
    const idx = new Uint8Array(2)
    new DataView(idx.buffer).setUint16(0, index, true)
    return pda(
      [utf8ToBytes('pool'), idx, owner.toBytes(), baseMint.toBytes(), quoteMint.toBytes()],
      PUMP_AMM_PROGRAM_ID,
    )
  },
  /** the PumpSwap pool a graduated coin migrates into */
  canonicalAmmPool: (mint: PublicKey, quoteMint: PublicKey) =>
    pumpPda.ammPool(CANONICAL_POOL_INDEX, pumpPda.poolAuthority(mint), mint, quoteMint),
}

/** Anchor instruction discriminator: sha256("global:<name>")[0..8] */
export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(utf8ToBytes(`global:${name}`)).slice(0, 8)
}

// ── account decoders ─────────────────────────────────────────────────────────

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

export interface BondingCurve {
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
  realTokenReserves: bigint
  realQuoteReserves: bigint
  tokenTotalSupply: bigint
  /** graduated: trading moved to the PumpSwap pool */
  complete: boolean
  /** the coin's creator — after "Share creator rewards" this is the sharing config PDA */
  creator: PublicKey
  isMayhemMode: boolean
  isCashbackCoin: boolean
  /** the pair's quote token (PUMP for our launch) */
  quoteMint: PublicKey
  /** creator fee, basis points of volume (300 = 3%) */
  creatorFeeBps: bigint
}

export const BONDING_CURVE_MIN_LEN = 8 + 5 * 8 + 1 + 32 + 2 + 32 + 8

/** pump.json `BondingCurve` (8-byte discriminator first). */
export function decodeBondingCurve(data: Uint8Array): BondingCurve {
  if (data.length < BONDING_CURVE_MIN_LEN) {
    throw new Error(`bonding curve account too short (${data.length} bytes)`)
  }
  const v = view(data)
  let o = 8
  const u64 = () => {
    const x = v.getBigUint64(o, true)
    o += 8
    return x
  }
  const bool = () => data[o++] === 1
  const key = () => {
    const k = new PublicKey(data.subarray(o, o + 32))
    o += 32
    return k
  }
  return {
    virtualTokenReserves: u64(),
    virtualQuoteReserves: u64(),
    realTokenReserves: u64(),
    realQuoteReserves: u64(),
    tokenTotalSupply: u64(),
    complete: bool(),
    creator: key(),
    isMayhemMode: bool(),
    isCashbackCoin: bool(),
    quoteMint: key(),
    creatorFeeBps: u64(),
  }
}

export interface Shareholder {
  address: PublicKey
  shareBps: number
}

export interface SharingConfig {
  version: number
  status: number
  mint: PublicKey
  admin: PublicKey
  /** true once the admin can no longer change the shares (what we want at launch) */
  adminRevoked: boolean
  shareholders: Shareholder[]
}

/** pump_fees.json `SharingConfig`: bump, version, status, mint, admin, admin_revoked, Vec<{pubkey, u16 bps}>. */
export function decodeSharingConfig(data: Uint8Array): SharingConfig {
  if (data.length < 8 + 3 + 64 + 1 + 4)
    throw new Error(`sharing config account too short (${data.length} bytes)`)
  const v = view(data)
  let o = 8
  o += 1 // bump
  const version = data[o++]!
  const status = data[o++]!
  const mint = new PublicKey(data.subarray(o, o + 32))
  o += 32
  const admin = new PublicKey(data.subarray(o, o + 32))
  o += 32
  const adminRevoked = data[o++] === 1
  const n = v.getUint32(o, true)
  o += 4
  if (n > 64 || data.length < o + n * 34) throw new Error(`sharing config: invalid shareholder count ${n}`)
  const shareholders: Shareholder[] = []
  for (let i = 0; i < n; i++) {
    const address = new PublicKey(data.subarray(o, o + 32))
    o += 32
    const shareBps = v.getUint16(o, true)
    o += 2
    shareholders.push({ address, shareBps })
  }
  return { version, status, mint, admin, adminRevoked, shareholders }
}

export interface AmmPool {
  index: number
  creator: PublicKey
  baseMint: PublicKey
  quoteMint: PublicKey
  lpMint: PublicKey
  poolBaseTokenAccount: PublicKey
  poolQuoteTokenAccount: PublicKey
  lpSupply: bigint
  coinCreator: PublicKey
}

export const AMM_POOL_MIN_LEN = 8 + 1 + 2 + 32 * 6 + 8 + 32

/** pump_amm.json `Pool` (8-byte discriminator first). */
export function decodeAmmPool(data: Uint8Array): AmmPool {
  if (data.length < AMM_POOL_MIN_LEN)
    throw new Error(`PumpSwap pool account too short (${data.length} bytes)`)
  const v = view(data)
  let o = 8
  o += 1 // pool_bump
  const index = v.getUint16(o, true)
  o += 2
  const key = () => {
    const k = new PublicKey(data.subarray(o, o + 32))
    o += 32
    return k
  }
  const creator = key()
  const baseMint = key()
  const quoteMint = key()
  const lpMint = key()
  const poolBaseTokenAccount = key()
  const poolQuoteTokenAccount = key()
  const lpSupply = v.getBigUint64(o, true)
  o += 8
  const coinCreator = key()
  return {
    index,
    creator,
    baseMint,
    quoteMint,
    lpMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    lpSupply,
    coinCreator,
  }
}

// ── price math (exact, floor at 1e18) ────────────────────────────────────────

function assertDecimals(d: number, label: string): void {
  if (!Number.isInteger(d) || d < 0 || d > 30) throw new RangeError(`${label}: invalid decimals ${d}`)
}

/** Price of 1 whole base token in whole quote tokens × 1e18 from a reserve pair (raw units). */
export function reservesPriceQuotePerBaseE18(
  baseReserveRaw: bigint,
  quoteReserveRaw: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  if (baseReserveRaw <= 0n) throw new RangeError('base reserve must be > 0')
  if (quoteReserveRaw < 0n) throw new RangeError('quote reserve must be ≥ 0')
  assertDecimals(baseDecimals, 'base')
  assertDecimals(quoteDecimals, 'quote')
  const k = baseDecimals - quoteDecimals + 18
  const num = quoteReserveRaw * (k >= 0 ? pow10(k) : 1n)
  const den = baseReserveRaw * (k < 0 ? pow10(-k) : 1n)
  return num / den
}

/** The bonding curve's spot price (its virtual reserves), PUMP per whole SCRATCHY × 1e18. */
export function curvePriceQuotePerBaseE18(
  curve: BondingCurve,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  return reservesPriceQuotePerBaseE18(
    curve.virtualTokenReserves,
    curve.virtualQuoteReserves,
    baseDecimals,
    quoteDecimals,
  )
}

// ── instructions ─────────────────────────────────────────────────────────────

const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true })
const signerRw = (pubkey: PublicKey) => ({ pubkey, isSigner: true, isWritable: true })

export const ata = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, true, tokenProgram)

/**
 * pump `distribute_creator_fees_v2`: pay the bonding curve's creator vault out to the sharing config's
 * shareholders. Permissionless: `payer` signs and funds any shareholder PUMP account it has to create.
 * Remaining accounts for a non-SOL quote: the shareholders, then their quote ATAs, in the config's order.
 */
export function distributeCreatorFeesV2Ix(o: {
  payer: PublicKey
  mint: PublicKey
  quoteMint: PublicKey
  quoteTokenProgram: PublicKey
  shareholders: PublicKey[]
  initializeAta?: boolean
}): TransactionInstruction {
  const sharingConfig = pumpPda.sharingConfig(o.mint)
  const creatorVault = pumpPda.creatorVault(sharingConfig)
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      signerRw(o.payer),
      ro(o.mint),
      ro(pumpPda.bondingCurve(o.mint)),
      ro(sharingConfig),
      rw(creatorVault),
      ro(SystemProgram.programId),
      ro(pumpPda.eventAuthority()),
      ro(PUMP_PROGRAM_ID),
      rw(ata(creatorVault, o.quoteMint, o.quoteTokenProgram)),
      ro(o.quoteMint),
      ro(o.quoteTokenProgram),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ...o.shareholders.map(ro),
      ...o.shareholders.map((s) => rw(ata(s, o.quoteMint, o.quoteTokenProgram))),
    ],
    data: Buffer.concat([
      Buffer.from(anchorDiscriminator('distribute_creator_fees_v2')),
      Buffer.from([o.initializeAta === false ? 0 : 1]),
    ]),
  })
}

/** PumpSwap `transfer_creator_fees_to_pump_v2`: after graduation, move the AMM-side creator fees into the pump creator vault. */
export function transferCreatorFeesToPumpV2Ix(o: {
  payer: PublicKey
  coinCreator: PublicKey
  quoteMint: PublicKey
  quoteTokenProgram: PublicKey
}): TransactionInstruction {
  const authority = pumpPda.ammCreatorVaultAuthority(o.coinCreator)
  const pumpVault = pumpPda.creatorVault(o.coinCreator)
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      signerRw(o.payer),
      ro(o.quoteMint),
      ro(o.quoteTokenProgram),
      ro(SystemProgram.programId),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(o.coinCreator),
      rw(authority),
      rw(ata(authority, o.quoteMint, o.quoteTokenProgram)),
      rw(pumpVault),
      rw(ata(pumpVault, o.quoteMint, o.quoteTokenProgram)),
      ro(pumpPda.ammEventAuthority()),
      ro(PUMP_AMM_PROGRAM_ID),
    ],
    data: Buffer.from(anchorDiscriminator('transfer_creator_fees_to_pump_v2')),
  })
}
