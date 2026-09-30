import {
  ComputeBudgetProgram,
  Transaction,
  type Connection,
  type Keypair,
  type PublicKey,
  type Signer,
} from '@solana/web3.js'
import { readTokenAmount } from './damm-v2'
import {
  ata,
  curvePriceQuotePerBaseE18,
  decodeAmmPool,
  decodeBondingCurve,
  decodeSharingConfig,
  distributeCreatorFeesV2Ix,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  pumpPda,
  reservesPriceQuotePerBaseE18,
  transferCreatorFeesToPumpV2Ix,
  type BondingCurve,
  type SharingConfig,
} from './pumpfun-program'
import {
  sendAndConfirmSignedWithSlot,
  txOwnerTokenDeltas,
  type ConfirmedTx,
  type TxDeltaOptions,
} from './send'
import type { ClaimResult, PoolState, VenueAdapter } from './types'

/**
 * pump.fun venue adapter — the launch venue (decision 2026-09-29, same setup as cockfight):
 * $SCRATCHY is launched on pump.fun as a **Custom Pair with PUMP as the quote token and a 3% creator fee**,
 * and "Share creator rewards" splits that fee **70% → PRIZE / 30% → OPS** on-chain (the sharing config).
 *
 *  - Fees accrue in PUMP in the coin's creator vault (bonding curve) and, after graduation, in the PumpSwap
 *    creator vault. `claimFees` sends the permissionless `distribute_creator_fees_v2` (preceded by
 *    `transfer_creator_fees_to_pump_v2` once graduated), **signed and paid by PRIZE**: the shares land in
 *    PRIZE's and OPS's PUMP accounts directly. No CREATOR key exists on the server at all.
 *  - The amounts booked are PRIZE's / OPS's token deltas from the confirmed tx's OWN meta (never balance reads).
 *  - price: the bonding curve's virtual reserves while it is live; the PumpSwap pool's reserves once graduated.
 *  - boot checks (`create`): the coin is a pump.fun coin quoted in PUMP, its creator IS the sharing config
 *    ("Share creator rewards" done), and the config's shareholders are exactly PRIZE at FEE_SPLIT_POOL and
 *    OPS at the rest. Soft checks (returned as `warnings`): the creator fee isn't 3%, the config admin is not
 *    revoked yet (shares could still be changed), the mint's decimals.
 */

export interface PumpfunVenueOptions {
  connection: Connection
  /** PRIZE (hot): signs + pays the permissionless distribution and receives its share */
  payer: Keypair
  /** SCRATCHY */
  mint: PublicKey
  /** PUMP (the pair's quote token) */
  quoteMint: PublicKey
  opsAddress: PublicKey
  /** PRIZE's expected share of the creator fee in bps (FEE_SPLIT_POOL × 10 000) */
  expectedPrizeShareBps: number
  /** expected creator fee in bps (POOL_TRADING_FEE × 10 000; 300 = 3%) — mismatch is a warning */
  expectedCreatorFeeBps?: number
  priorityFeeMicroLamports?: number
  computeUnitLimit?: number
  /** test seams */
  send?: (tx: Transaction, signers: Signer[]) => Promise<ConfirmedTx>
  deltaOptions?: TxDeltaOptions
}

export interface PumpfunStatics {
  bondingCurve: PublicKey
  sharingConfig: PublicKey
  creatorVault: PublicKey
  creatorVaultAta: PublicKey
  ammCreatorVaultAuthority: PublicKey
  ammCreatorVaultAta: PublicKey
  canonicalPool: PublicKey
  baseTokenProgram: PublicKey
  quoteTokenProgram: PublicKey
  baseDecimals: number
  quoteDecimals: number
  shareholders: PublicKey[]
  prizeShareBps: number
  opsShareBps: number
  creatorFeeBps: number
  adminRevoked: boolean
}

const DEFAULT_CU_LIMIT = 400_000

/** Mint decimals + owning token program from the raw mint account (same base layout for Token and Token-2022). */
async function readMint(
  connection: Connection,
  mint: PublicKey,
): Promise<{ decimals: number; tokenProgram: PublicKey }> {
  const info = await connection.getAccountInfo(mint, 'confirmed')
  if (!info || info.data.length < 82) throw new Error(`mint ${mint.toBase58()} not found`)
  return { decimals: info.data[44]!, tokenProgram: info.owner }
}

/** Validate the sharing config against our wallets; returns the shareholder order (as the program expects). */
export function checkSharingConfig(
  cfg: SharingConfig,
  mint: PublicKey,
  prize: PublicKey,
  ops: PublicKey,
  expectedPrizeShareBps: number,
): { shareholders: PublicKey[]; prizeShareBps: number; opsShareBps: number } {
  if (!cfg.mint.equals(mint)) {
    throw new Error(`sharing config is for mint ${cfg.mint.toBase58()}, not ${mint.toBase58()}`)
  }
  const total = cfg.shareholders.reduce((s, h) => s + h.shareBps, 0)
  if (total !== 10_000) throw new Error(`sharing config shares sum to ${total} bps, not 10 000`)
  const prizeShare = cfg.shareholders.find((h) => h.address.equals(prize))
  const opsShare = cfg.shareholders.find((h) => h.address.equals(ops))
  if (!prizeShare) throw new Error(`PRIZE ${prize.toBase58()} is not a shareholder of the creator fees`)
  if (!opsShare) throw new Error(`OPS ${ops.toBase58()} is not a shareholder of the creator fees`)
  if (cfg.shareholders.length !== 2) {
    throw new Error(
      `sharing config has ${cfg.shareholders.length} shareholders; expected exactly PRIZE and OPS (` +
        cfg.shareholders.map((h) => `${h.address.toBase58()}:${h.shareBps}`).join(', ') +
        ')',
    )
  }
  if (prizeShare.shareBps !== expectedPrizeShareBps) {
    throw new Error(
      `PRIZE's share is ${prizeShare.shareBps} bps, but FEE_SPLIT_POOL expects ${expectedPrizeShareBps} bps — ` +
        'fix the sharing config on pump.fun or FEE_SPLIT_POOL',
    )
  }
  return {
    shareholders: cfg.shareholders.map((h) => h.address),
    prizeShareBps: prizeShare.shareBps,
    opsShareBps: opsShare.shareBps,
  }
}

export class PumpfunVenue implements VenueAdapter {
  readonly name = 'pumpfun'
  readonly distributesDirectly = true
  /** soft boot findings (services.ts alerts them as warnings) */
  readonly warnings: string[] = []
  /** informational boot findings (services.ts logs them) */
  readonly notes: string[] = []
  private readonly connection: Connection
  private readonly payer: Keypair
  private readonly mint: PublicKey
  private readonly quoteMint: PublicKey
  private readonly ops: PublicKey
  private readonly expectedPrizeShareBps: number
  private readonly expectedCreatorFeeBps: number | undefined
  private readonly priorityFeeMicroLamports: number | undefined
  private readonly computeUnitLimit: number
  private readonly send: (tx: Transaction, signers: Signer[]) => Promise<ConfirmedTx>
  private readonly deltaOptions: TxDeltaOptions | undefined
  private statics: PumpfunStatics | null = null
  private initializing: Promise<PumpfunStatics> | null = null

  constructor(opts: PumpfunVenueOptions) {
    if (opts.mint.equals(opts.quoteMint)) throw new Error('PumpfunVenue: base and quote mints must differ')
    if (opts.payer.publicKey.equals(opts.opsAddress))
      throw new Error('PumpfunVenue: PRIZE and OPS must differ')
    if (
      !Number.isInteger(opts.expectedPrizeShareBps) ||
      opts.expectedPrizeShareBps <= 0 ||
      opts.expectedPrizeShareBps >= 10_000
    ) {
      throw new RangeError(`PumpfunVenue: expectedPrizeShareBps ${opts.expectedPrizeShareBps} out of range`)
    }
    this.connection = opts.connection
    this.payer = opts.payer
    this.mint = opts.mint
    this.quoteMint = opts.quoteMint
    this.ops = opts.opsAddress
    this.expectedPrizeShareBps = opts.expectedPrizeShareBps
    this.expectedCreatorFeeBps = opts.expectedCreatorFeeBps
    this.priorityFeeMicroLamports = opts.priorityFeeMicroLamports
    this.computeUnitLimit = opts.computeUnitLimit ?? DEFAULT_CU_LIMIT
    this.deltaOptions = opts.deltaOptions
    this.send =
      opts.send ??
      ((tx, signers) =>
        sendAndConfirmSignedWithSlot(this.connection, tx, signers, {
          label: 'pumpfun distribute_creator_fees_v2',
        }))
  }

  /** Construct and run the boot checks. */
  static async create(opts: PumpfunVenueOptions): Promise<PumpfunVenue> {
    const v = new PumpfunVenue(opts)
    await v.init()
    return v
  }

  init(): Promise<PumpfunStatics> {
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

  private async readCurve(): Promise<{ curve: BondingCurve; slot: number }> {
    const r = await this.connection.getAccountInfoAndContext(pumpPda.bondingCurve(this.mint), 'confirmed')
    if (!r.value) {
      throw new Error(
        `bonding curve account not found: is SCRATCHY_MINT ${this.mint.toBase58()} a pump.fun coin?`,
      )
    }
    if (!r.value.owner.equals(PUMP_PROGRAM_ID)) {
      throw new Error(`bonding curve account is owned by ${r.value.owner.toBase58()}, not the pump program`)
    }
    return { curve: decodeBondingCurve(r.value.data), slot: r.context.slot }
  }

  private async load(): Promise<PumpfunStatics> {
    const { curve } = await this.readCurve()
    if (!curve.quoteMint.equals(this.quoteMint)) {
      throw new Error(
        `the coin's quote mint is ${curve.quoteMint.toBase58()}, not PUMP ${this.quoteMint.toBase58()} — ` +
          'launch it as a Custom Pair quoted in PUMP',
      )
    }
    const sharingConfig = pumpPda.sharingConfig(this.mint)
    if (!curve.creator.equals(sharingConfig)) {
      throw new Error(
        `creator fees are not shared yet (creator is ${curve.creator.toBase58()}): set up "Share creator rewards" ` +
          'on pump.fun with PRIZE and OPS as the shareholders first',
      )
    }
    const cfgInfo = await this.connection.getAccountInfo(sharingConfig, 'confirmed')
    if (!cfgInfo) throw new Error('sharing config account not found')
    if (!cfgInfo.owner.equals(PUMP_FEES_PROGRAM_ID)) {
      throw new Error(`sharing config is owned by ${cfgInfo.owner.toBase58()}, not the pump fees program`)
    }
    const cfg = decodeSharingConfig(cfgInfo.data)
    const shares = checkSharingConfig(
      cfg,
      this.mint,
      this.payer.publicKey,
      this.ops,
      this.expectedPrizeShareBps,
    )
    const [base, quote] = await Promise.all([
      readMint(this.connection, this.mint),
      readMint(this.connection, this.quoteMint),
    ])
    const creatorFeeBps = Number(curve.creatorFeeBps)
    if (this.expectedCreatorFeeBps !== undefined && creatorFeeBps !== this.expectedCreatorFeeBps) {
      this.warnings.push(
        `the coin's creator fee is ${creatorFeeBps} bps (${creatorFeeBps / 100}%), not the planned ${this.expectedCreatorFeeBps} bps`,
      )
    }
    if (!cfg.adminRevoked && !cfg.admin.equals(this.ops)) {
      this.warnings.push(
        `the sharing config admin is ${cfg.admin.toBase58()} (not OPS) and not revoked: that wallet can change the fee split at any time`,
      )
    }
    if (!cfg.adminRevoked && cfg.admin.equals(this.ops)) {
      this.notes.push(
        'the sharing config admin (OPS) is not revoked: OPS can still re-point the 70% share, e.g. to rotate a compromised PRIZE wallet',
      )
    }
    const creatorVault = pumpPda.creatorVault(sharingConfig)
    const ammAuthority = pumpPda.ammCreatorVaultAuthority(sharingConfig)
    return {
      bondingCurve: pumpPda.bondingCurve(this.mint),
      sharingConfig,
      creatorVault,
      creatorVaultAta: ata(creatorVault, this.quoteMint, quote.tokenProgram),
      ammCreatorVaultAuthority: ammAuthority,
      ammCreatorVaultAta: ata(ammAuthority, this.quoteMint, quote.tokenProgram),
      canonicalPool: pumpPda.canonicalAmmPool(this.mint, this.quoteMint),
      baseTokenProgram: base.tokenProgram,
      quoteTokenProgram: quote.tokenProgram,
      baseDecimals: base.decimals,
      quoteDecimals: quote.decimals,
      shareholders: shares.shareholders,
      prizeShareBps: shares.prizeShareBps,
      opsShareBps: shares.opsShareBps,
      creatorFeeBps,
      adminRevoked: cfg.adminRevoked,
    }
  }

  /**
   * The bonding curve + its SCRATCHY account, the creator vaults, the sharing config, the PumpSwap pool
   * authority + canonical pool (+ its SCRATCHY account): they hold SCRATCHY but are not players.
   */
  excludedAddresses(): string[] {
    const s = this.statics
    const bondingCurve = pumpPda.bondingCurve(this.mint)
    const sharingConfig = pumpPda.sharingConfig(this.mint)
    const poolAuthority = pumpPda.poolAuthority(this.mint)
    const pool = pumpPda.canonicalAmmPool(this.mint, this.quoteMint)
    const out = [
      bondingCurve,
      sharingConfig,
      pumpPda.creatorVault(sharingConfig),
      pumpPda.ammCreatorVaultAuthority(sharingConfig),
      poolAuthority,
      pool,
      PUMP_PROGRAM_ID,
      PUMP_AMM_PROGRAM_ID,
    ]
    if (s) {
      out.push(ata(bondingCurve, this.mint, s.baseTokenProgram), ata(pool, this.mint, s.baseTokenProgram))
    }
    return [...new Set(out.map((k) => k.toBase58()))]
  }

  async getPoolState(): Promise<PoolState> {
    const s = await this.init()
    const { curve, slot } = await this.readCurve()
    const base = {
      baseMint: this.mint.toBase58(),
      quoteMint: this.quoteMint.toBase58(),
      baseDecimals: s.baseDecimals,
      quoteDecimals: s.quoteDecimals,
    }
    if (curve.complete) {
      const amm = await this.readAmmPool(s)
      if (amm) return { address: s.canonicalPool.toBase58(), ...base, ...amm }
      // graduated but not migrated yet (pump.fun migrates within moments): the curve's final price stands
    }
    return {
      address: s.bondingCurve.toBase58(),
      ...base,
      baseReserveRaw: curve.realTokenReserves,
      quoteReserveRaw: curve.realQuoteReserves,
      priceQuotePerBaseE18: curvePriceQuotePerBaseE18(curve, s.baseDecimals, s.quoteDecimals),
      slot,
    }
  }

  private async readAmmPool(s: PumpfunStatics): Promise<{
    baseReserveRaw: bigint
    quoteReserveRaw: bigint
    priceQuotePerBaseE18: bigint
    slot: number
  } | null> {
    const info = await this.connection.getAccountInfo(s.canonicalPool, 'confirmed')
    if (!info) return null
    if (!info.owner.equals(PUMP_AMM_PROGRAM_ID)) {
      throw new Error(`PumpSwap pool ${s.canonicalPool.toBase58()} is owned by ${info.owner.toBase58()}`)
    }
    const pool = decodeAmmPool(info.data)
    if (!pool.baseMint.equals(this.mint) || !pool.quoteMint.equals(this.quoteMint)) {
      throw new Error(
        `PumpSwap pool mints (base ${pool.baseMint.toBase58()}, quote ${pool.quoteMint.toBase58()}) do not match ` +
          `SCRATCHY ${this.mint.toBase58()} / PUMP ${this.quoteMint.toBase58()}`,
      )
    }
    const r = await this.connection.getMultipleAccountsInfoAndContext(
      [pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount],
      'confirmed',
    )
    const [b, q] = r.value
    if (!b || !q) throw new Error(`PumpSwap pool ${s.canonicalPool.toBase58()}: token account missing`)
    const baseReserveRaw = readTokenAmount(b.data)
    const quoteReserveRaw = readTokenAmount(q.data)
    return {
      baseReserveRaw,
      quoteReserveRaw,
      priceQuotePerBaseE18: reservesPriceQuotePerBaseE18(
        baseReserveRaw,
        quoteReserveRaw,
        s.baseDecimals,
        s.quoteDecimals,
      ),
      slot: r.context.slot,
    }
  }

  private async tokenAmount(account: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(account, 'confirmed')
    if (!info || info.data.length < 72) return 0n
    return readTokenAmount(info.data)
  }

  /** PUMP waiting in the creator vault (+ the AMM creator vault after graduation). Never any SCRATCHY. */
  async pendingFees(): Promise<{ quoteRaw: bigint; baseRaw: bigint }> {
    const s = await this.init()
    const [vault, amm] = await Promise.all([
      this.tokenAmount(s.creatorVaultAta),
      this.tokenAmount(s.ammCreatorVaultAta),
    ])
    return { quoteRaw: vault + amm, baseRaw: 0n }
  }

  /** Where the fees sit right now (for logs/admin). */
  async stage(): Promise<'curve' | 'amm'> {
    const { curve } = await this.readCurve()
    return curve.complete ? 'amm' : 'curve'
  }

  async claimFees(): Promise<ClaimResult> {
    const s = await this.init()
    const { curve } = await this.readCurve()
    const tx = new Transaction()
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }))
    if (this.priorityFeeMicroLamports && this.priorityFeeMicroLamports > 0) {
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFeeMicroLamports }))
    }
    let ammPart = 0n
    if (curve.complete) {
      ammPart = await this.tokenAmount(s.ammCreatorVaultAta)
      if (ammPart > 0n) {
        tx.add(
          transferCreatorFeesToPumpV2Ix({
            payer: this.payer.publicKey,
            coinCreator: s.sharingConfig,
            quoteMint: this.quoteMint,
            quoteTokenProgram: s.quoteTokenProgram,
          }),
        )
      }
    }
    const inVault = await this.tokenAmount(s.creatorVaultAta)
    if (inVault === 0n && ammPart === 0n) throw new Error('nothing to claim: the creator vault is empty')
    tx.add(
      distributeCreatorFeesV2Ix({
        payer: this.payer.publicKey,
        mint: this.mint,
        quoteMint: this.quoteMint,
        quoteTokenProgram: s.quoteTokenProgram,
        shareholders: s.shareholders,
        initializeAta: true,
      }),
    )
    tx.feePayer = this.payer.publicKey
    const confirmed = await this.send(tx, [this.payer])
    const quote = this.quoteMint.toBase58()
    const [prizeDeltas, opsDeltas] = await Promise.all([
      txOwnerTokenDeltas(this.connection, confirmed.signature, this.payer.publicKey, this.deltaOptions),
      txOwnerTokenDeltas(this.connection, confirmed.signature, this.ops, this.deltaOptions),
    ])
    const toPrizeRaw = prizeDeltas.get(quote) ?? 0n
    const toOpsRaw = opsDeltas.get(quote) ?? 0n
    if (toPrizeRaw < 0n || toOpsRaw < 0n) {
      throw new Error(
        `claim ${confirmed.signature} moved PUMP the wrong way (PRIZE ${toPrizeRaw}, OPS ${toOpsRaw})`,
      )
    }
    return {
      signatures: [confirmed.signature],
      claimedQuoteRaw: toPrizeRaw + toOpsRaw,
      claimedBaseRaw: 0n,
      distributed: { toPrizeRaw, toOpsRaw, slot: confirmed.slot },
    }
  }

  /** The creator fee is 100% ours (no LP share to dilute it). */
  async creatorLiquidityShare(): Promise<number> {
    return 1
  }
}
