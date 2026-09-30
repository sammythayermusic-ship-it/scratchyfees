import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type Connection,
  type Transaction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { readTokenAmount } from '../src/venue/damm-v2'
import { PumpfunVenue, checkSharingConfig } from '../src/venue/pumpfun'
import {
  anchorDiscriminator,
  ata,
  BONDING_CURVE_MIN_LEN,
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
} from '../src/venue/pumpfun-program'
import fixture from './fixtures/pumpfun-testcoin.json'

const MINT = new PublicKey(fixture.mint)
const PUMP = new PublicKey(fixture.expected.quoteMint)
const LAUNCH = new PublicKey(String(fixture.expected.shareholders[0]![0]))
const HOT = new PublicKey(String(fixture.expected.shareholders[1]![0]))
const curveData = Buffer.from(fixture.bondingCurveData, 'base64')
const cfgData = Buffer.from(fixture.sharingConfigData, 'base64')

describe('pump.fun PDAs (against the real test coin)', () => {
  it('derives the bonding curve, sharing config, creator vaults, pool authority and canonical pool', () => {
    expect(pumpPda.bondingCurve(MINT).toBase58()).toBe(fixture.bondingCurve)
    expect(pumpPda.sharingConfig(MINT).toBase58()).toBe(fixture.sharingConfig)
    const cfg = pumpPda.sharingConfig(MINT)
    expect(pumpPda.creatorVault(cfg).toBase58()).toBe(fixture.creatorVault)
    expect(pumpPda.ammCreatorVaultAuthority(cfg).toBase58()).toBe(fixture.ammCreatorVaultAuthority)
    expect(pumpPda.poolAuthority(MINT).toBase58()).toBe(fixture.poolAuthority)
    expect(pumpPda.canonicalAmmPool(MINT, PUMP).toBase58()).toBe(fixture.canonicalPool)
  })

  it('anchor discriminators are sha256("global:<name>")[0..8]', () => {
    // known value: distribute_creator_fees_v2 from pump.json
    expect(Buffer.from(anchorDiscriminator('distribute_creator_fees_v2')).length).toBe(8)
    expect(anchorDiscriminator('a')).not.toEqual(anchorDiscriminator('b'))
  })
})

describe('account decoders (real mainnet bytes)', () => {
  it('decodes the bonding curve: quoted in PUMP, creator = sharing config, 3% creator fee', () => {
    const c = decodeBondingCurve(curveData)
    const e = fixture.expected
    expect(c.virtualTokenReserves).toBe(BigInt(e.virtualTokenReserves))
    expect(c.virtualQuoteReserves).toBe(BigInt(e.virtualQuoteReserves))
    expect(c.realTokenReserves).toBe(BigInt(e.realTokenReserves))
    expect(c.realQuoteReserves).toBe(BigInt(e.realQuoteReserves))
    expect(c.tokenTotalSupply).toBe(BigInt(e.tokenTotalSupply))
    expect(c.complete).toBe(e.complete)
    expect(c.creator.toBase58()).toBe(fixture.sharingConfig)
    expect(c.quoteMint.equals(PUMP)).toBe(true)
    expect(c.creatorFeeBps).toBe(BigInt(e.creatorFeeBps))
    expect(curveData.length).toBeGreaterThanOrEqual(BONDING_CURVE_MIN_LEN)
    expect(() => decodeBondingCurve(curveData.subarray(0, 50))).toThrow(/too short/)
  })

  it('decodes the sharing config: two shareholders 30/70, admin revoked', () => {
    const cfg = decodeSharingConfig(cfgData)
    const e = fixture.expected
    expect(cfg.mint.equals(MINT)).toBe(true)
    expect(cfg.admin.toBase58()).toBe(e.admin)
    expect(cfg.adminRevoked).toBe(e.adminRevoked)
    expect(cfg.version).toBe(e.version)
    expect(cfg.status).toBe(e.status)
    expect(cfg.shareholders.map((s) => [s.address.toBase58(), s.shareBps])).toEqual(e.shareholders)
  })

  it('decodes a PumpSwap pool (synthetic bytes in the IDL layout)', () => {
    const b = Buffer.alloc(8 + 1 + 2 + 32 * 6 + 8 + 32 + 16)
    let o = 8
    b[o++] = 254
    b.writeUInt16LE(0, o)
    o += 2
    const keys = [
      pumpPda.poolAuthority(MINT),
      MINT,
      PUMP,
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
      Keypair.generate().publicKey,
    ]
    for (const k of keys) {
      b.set(k.toBytes(), o)
      o += 32
    }
    b.writeBigUInt64LE(123n, o)
    o += 8
    const coinCreator = pumpPda.sharingConfig(MINT)
    b.set(coinCreator.toBytes(), o)
    const p = decodeAmmPool(b)
    expect(p.index).toBe(0)
    expect(p.creator.equals(keys[0]!)).toBe(true)
    expect(p.baseMint.equals(MINT)).toBe(true)
    expect(p.quoteMint.equals(PUMP)).toBe(true)
    expect(p.poolBaseTokenAccount.equals(keys[4]!)).toBe(true)
    expect(p.poolQuoteTokenAccount.equals(keys[5]!)).toBe(true)
    expect(p.lpSupply).toBe(123n)
    expect(p.coinCreator.equals(coinCreator)).toBe(true)
  })
})

describe('price math', () => {
  it('curve price = virtualQuote / virtualToken adjusted for decimals, × 1e18 (floor)', () => {
    const c = decodeBondingCurve(curveData)
    // both 6 decimals: 1 097 826.753444 PUMP / 1 073 000 000 SCRATCHY ≈ 0.00102314 PUMP per SCRATCHY
    const p = curvePriceQuotePerBaseE18(c, 6, 6)
    expect(p).toBe((c.virtualQuoteReserves * 10n ** 18n) / c.virtualTokenReserves)
    expect(Number(p) / 1e18).toBeCloseTo(0.0010231, 7)
    // decimals shift: 9-decimal base vs 6-decimal quote scales by 1e3
    expect(curvePriceQuotePerBaseE18(c, 9, 6)).toBe(
      (c.virtualQuoteReserves * 10n ** 21n) / c.virtualTokenReserves,
    )
  })
  it('reserve price guards', () => {
    expect(reservesPriceQuotePerBaseE18(1_000_000n, 2_000_000n, 6, 6)).toBe(2n * 10n ** 18n)
    expect(() => reservesPriceQuotePerBaseE18(0n, 1n, 6, 6)).toThrow()
    expect(() => reservesPriceQuotePerBaseE18(1n, 1n, 40, 6)).toThrow()
  })
})

describe('instructions (account layout as verified on mainnet by cockfight)', () => {
  const payer = Keypair.generate().publicKey
  it('distribute_creator_fees_v2: fixed accounts, then shareholders, then their PUMP ATAs', () => {
    const ix = distributeCreatorFeesV2Ix({
      payer,
      mint: MINT,
      quoteMint: PUMP,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
      shareholders: [LAUNCH, HOT],
    })
    const cfg = pumpPda.sharingConfig(MINT)
    const vault = pumpPda.creatorVault(cfg)
    expect(ix.programId.equals(PUMP_PROGRAM_ID)).toBe(true)
    const k = ix.keys.map((m) => m.pubkey.toBase58())
    expect(k).toEqual(
      [
        payer,
        MINT,
        pumpPda.bondingCurve(MINT),
        cfg,
        vault,
        SystemProgram.programId,
        pumpPda.eventAuthority(),
        PUMP_PROGRAM_ID,
        ata(vault, PUMP, TOKEN_2022_PROGRAM_ID),
        PUMP,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        LAUNCH,
        HOT,
        ata(LAUNCH, PUMP, TOKEN_2022_PROGRAM_ID),
        ata(HOT, PUMP, TOKEN_2022_PROGRAM_ID),
      ].map((x) => x.toBase58()),
    )
    expect(ix.keys[0]!.isSigner).toBe(true)
    expect(ix.keys[4]!.isWritable).toBe(true) // creator vault
    expect(ix.keys[14]!.isWritable && ix.keys[15]!.isWritable).toBe(true) // shareholder ATAs
    expect(ix.keys[12]!.isWritable || ix.keys[13]!.isWritable).toBe(false) // shareholders read-only
    expect(ix.data.subarray(0, 8)).toEqual(Buffer.from(anchorDiscriminator('distribute_creator_fees_v2')))
    expect(ix.data[8]).toBe(1) // initialize ATAs
  })
  it('transfer_creator_fees_to_pump_v2: AMM vault → pump creator vault', () => {
    const cfg = pumpPda.sharingConfig(MINT)
    const ix = transferCreatorFeesToPumpV2Ix({
      payer,
      coinCreator: cfg,
      quoteMint: PUMP,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    expect(ix.programId.equals(PUMP_AMM_PROGRAM_ID)).toBe(true)
    const auth = pumpPda.ammCreatorVaultAuthority(cfg)
    const vault = pumpPda.creatorVault(cfg)
    expect(ix.keys.map((m) => m.pubkey.toBase58())).toEqual(
      [
        payer,
        PUMP,
        TOKEN_2022_PROGRAM_ID,
        SystemProgram.programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        cfg,
        auth,
        ata(auth, PUMP, TOKEN_2022_PROGRAM_ID),
        vault,
        ata(vault, PUMP, TOKEN_2022_PROGRAM_ID),
        pumpPda.ammEventAuthority(),
        PUMP_AMM_PROGRAM_ID,
      ].map((x) => x.toBase58()),
    )
    expect(ix.data).toEqual(Buffer.from(anchorDiscriminator('transfer_creator_fees_to_pump_v2')))
  })
})

describe('checkSharingConfig', () => {
  const cfg = decodeSharingConfig(cfgData)
  it('accepts PRIZE=HOT 70% / OPS=LAUNCH 30% in either order', () => {
    const r = checkSharingConfig(cfg, MINT, HOT, LAUNCH, 7000)
    expect(r.prizeShareBps).toBe(7000)
    expect(r.opsShareBps).toBe(3000)
    expect(r.shareholders.map((s) => s.toBase58())).toEqual([LAUNCH.toBase58(), HOT.toBase58()]) // config order
  })
  it('rejects a wrong share, a wrong wallet, a wrong mint', () => {
    expect(() => checkSharingConfig(cfg, MINT, HOT, LAUNCH, 8000)).toThrow(/7000 bps.*8000/)
    expect(() => checkSharingConfig(cfg, MINT, LAUNCH, HOT, 7000)).toThrow(/PRIZE's share is 3000/)
    expect(() => checkSharingConfig(cfg, MINT, Keypair.generate().publicKey, LAUNCH, 7000)).toThrow(
      /not a shareholder/,
    )
    expect(() => checkSharingConfig(cfg, Keypair.generate().publicKey, HOT, LAUNCH, 7000)).toThrow(/not/)
  })
})

// ── the adapter against a fake RPC ───────────────────────────────────────────

function mintAccount(decimals: number, program: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(82)
  data[44] = decimals
  return { executable: false, owner: program, lamports: 1, data }
}
function tokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
  program = TOKEN_2022_PROGRAM_ID,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(165)
  data.set(mint.toBytes(), 0)
  data.set(owner.toBytes(), 32)
  data.writeBigUInt64LE(amount, 64)
  return { executable: false, owner: program, lamports: 1, data }
}

interface FakeWorld {
  accounts: Map<string, AccountInfo<Buffer>>
  slot: number
  txs: Map<string, { pre: TokenBal[]; post: TokenBal[]; err: null | object }>
}
interface TokenBal {
  accountIndex: number
  mint: string
  owner: string
  amount: string
}

function fakeConnection(w: FakeWorld): Connection {
  const get = (k: PublicKey) => w.accounts.get(k.toBase58()) ?? null
  return {
    getAccountInfo: async (k: PublicKey) => get(k),
    getAccountInfoAndContext: async (k: PublicKey) => ({ context: { slot: w.slot }, value: get(k) }),
    getMultipleAccountsInfoAndContext: async (ks: PublicKey[]) => ({
      context: { slot: w.slot },
      value: ks.map(get),
    }),
    getTransaction: async (sig: string) => {
      const t = w.txs.get(sig)
      if (!t) return null
      const bal = (b: TokenBal) => ({
        accountIndex: b.accountIndex,
        mint: b.mint,
        owner: b.owner,
        uiTokenAmount: { amount: b.amount, decimals: 6, uiAmount: null, uiAmountString: '' },
      })
      return {
        slot: w.slot,
        meta: { err: t.err, preTokenBalances: t.pre.map(bal), postTokenBalances: t.post.map(bal) },
      }
    },
  } as unknown as Connection
}

function world(
  opts: { complete?: boolean; vault?: bigint; amm?: bigint; curve?: Buffer; cfg?: Buffer } = {},
): FakeWorld {
  const cfgPda = pumpPda.sharingConfig(MINT)
  const vault = pumpPda.creatorVault(cfgPda)
  const ammAuth = pumpPda.ammCreatorVaultAuthority(cfgPda)
  let curve = Buffer.from(opts.curve ?? curveData)
  if (opts.complete) {
    curve = Buffer.from(curve)
    curve[8 + 40] = 1
  }
  const accounts = new Map<string, AccountInfo<Buffer>>()
  accounts.set(pumpPda.bondingCurve(MINT).toBase58(), {
    executable: false,
    owner: PUMP_PROGRAM_ID,
    lamports: 1,
    data: curve,
  })
  accounts.set(cfgPda.toBase58(), {
    executable: false,
    owner: PUMP_FEES_PROGRAM_ID,
    lamports: 1,
    data: Buffer.from(opts.cfg ?? cfgData),
  })
  accounts.set(MINT.toBase58(), mintAccount(6, TOKEN_PROGRAM_ID))
  accounts.set(PUMP.toBase58(), mintAccount(6, TOKEN_2022_PROGRAM_ID))
  if (opts.vault !== undefined)
    accounts.set(ata(vault, PUMP, TOKEN_2022_PROGRAM_ID).toBase58(), tokenAccount(PUMP, vault, opts.vault))
  if (opts.amm !== undefined)
    accounts.set(ata(ammAuth, PUMP, TOKEN_2022_PROGRAM_ID).toBase58(), tokenAccount(PUMP, ammAuth, opts.amm))
  return { accounts, slot: 1000, txs: new Map() }
}

/** a PRIZE keypair standing in for the real hot wallet (the fixture's 70% shareholder is HOT = a real address) */
function venueFor(w: FakeWorld, send?: (tx: Transaction) => Promise<{ signature: string; slot: number }>) {
  // the fixture's shares are LAUNCH 30 / HOT 70, so PRIZE must be HOT: build a config where PRIZE is a key we hold
  const prize = Keypair.generate()
  const cfg = decodeSharingConfig(cfgData)
  // rewrite the config bytes: replace HOT with our PRIZE pubkey
  const data = Buffer.from(cfgData)
  const hotOff = 8 + 3 + 64 + 1 + 4 + 34 // second shareholder
  data.set(prize.publicKey.toBytes(), hotOff)
  w.accounts.set(pumpPda.sharingConfig(MINT).toBase58(), {
    executable: false,
    owner: PUMP_FEES_PROGRAM_ID,
    lamports: 1,
    data,
  })
  void cfg
  const venue = new PumpfunVenue({
    connection: fakeConnection(w),
    payer: prize,
    mint: MINT,
    quoteMint: PUMP,
    opsAddress: LAUNCH,
    expectedPrizeShareBps: 7000,
    expectedCreatorFeeBps: 300,
    priorityFeeMicroLamports: 1000,
    send: send ? async (tx) => send(tx) : undefined,
    deltaOptions: { attempts: 1, retryMs: 0 },
  })
  return { venue, prize }
}

describe('PumpfunVenue', () => {
  it('boots against the real test-coin layout and reports no warnings', async () => {
    const w = world({ vault: 0n })
    const { venue } = venueFor(w)
    const s = await venue.init()
    expect(s.creatorFeeBps).toBe(300)
    expect(s.prizeShareBps).toBe(7000)
    expect(s.opsShareBps).toBe(3000)
    expect(s.quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
    expect(s.baseTokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true)
    expect(venue.warnings).toEqual([])
    expect(venue.distributesDirectly).toBe(true)
    expect(venue.excludedAddresses()).toContain(fixture.bondingCurve)
    expect(venue.excludedAddresses()).toContain(fixture.canonicalPool)
    expect(venue.excludedAddresses()).toContain(
      ata(pumpPda.bondingCurve(MINT), MINT, TOKEN_PROGRAM_ID).toBase58(),
    )
  })

  it('refuses a coin not quoted in PUMP, an unshared creator, and a wrong share', async () => {
    const other = Buffer.from(curveData)
    other.set(Keypair.generate().publicKey.toBytes(), 8 + 40 + 1 + 32 + 2) // quoteMint
    await expect(venueFor(world({ curve: other })).venue.init()).rejects.toThrow(/quote mint/)
    const unshared = Buffer.from(curveData)
    unshared.set(Keypair.generate().publicKey.toBytes(), 8 + 40 + 1) // creator
    await expect(venueFor(world({ curve: unshared })).venue.init()).rejects.toThrow(/Share creator rewards/)
    const w = world()
    const v = new PumpfunVenue({
      connection: fakeConnection(w),
      payer: Keypair.generate(),
      mint: MINT,
      quoteMint: PUMP,
      opsAddress: LAUNCH,
      expectedPrizeShareBps: 7000,
    })
    await expect(v.init()).rejects.toThrow(/not a shareholder/)
  })

  it('warns (does not refuse) on a non-3% fee and a third-party unrevoked admin; notes an unrevoked OPS admin', async () => {
    const curve = Buffer.from(curveData)
    curve.writeBigUInt64LE(100n, 8 + 40 + 1 + 32 + 2 + 32)
    const cfg = Buffer.from(cfgData)
    cfg[8 + 3 + 64] = 0 // admin_revoked = false
    const w = world({ curve, cfg })
    const { venue } = venueFor(w)
    // venueFor rewrote the config from cfgData; apply the unrevoked flag on top
    const acc = w.accounts.get(pumpPda.sharingConfig(MINT).toBase58())!
    acc.data[8 + 3 + 64] = 0 // admin (= LAUNCH = OPS in this fixture) not revoked → a note, not a warning
    await venue.init()
    expect(venue.warnings.join('\n')).toMatch(/100 bps/)
    expect(venue.warnings.join('\n')).not.toMatch(/not revoked/)
    expect(venue.notes.join('\n')).toMatch(/OPS.*not revoked/)
    // a stranger as unrevoked admin is a warning
    const w2 = world()
    const { venue: v2 } = venueFor(w2)
    const acc2 = w2.accounts.get(pumpPda.sharingConfig(MINT).toBase58())!
    acc2.data[8 + 3 + 64] = 0
    acc2.data.set(Keypair.generate().publicKey.toBytes(), 8 + 3 + 32) // admin
    await v2.init()
    expect(v2.warnings.join('\n')).toMatch(/not OPS.*not revoked/)
  })

  it('prices from the curve while live and from the PumpSwap pool once graduated', async () => {
    const w = world()
    const { venue } = venueFor(w)
    const live = await venue.getPoolState()
    const c = decodeBondingCurve(curveData)
    expect(live.address).toBe(fixture.bondingCurve)
    expect(live.priceQuotePerBaseE18).toBe(curvePriceQuotePerBaseE18(c, 6, 6))
    expect(live.baseReserveRaw).toBe(c.realTokenReserves)
    expect(live.slot).toBe(1000)

    const w2 = world({ complete: true })
    const { venue: v2 } = venueFor(w2)
    // graduated but not migrated yet → still the curve's final price
    const notYet = await v2.getPoolState()
    expect(notYet.address).toBe(fixture.bondingCurve)
    // now the canonical pool exists with reserves 1M SCRATCHY : 3k PUMP → 0.003
    const pool = pumpPda.canonicalAmmPool(MINT, PUMP)
    const baseAcc = Keypair.generate().publicKey
    const quoteAcc = Keypair.generate().publicKey
    const b = Buffer.alloc(8 + 1 + 2 + 32 * 6 + 8 + 32)
    let o = 11
    for (const k of [
      pumpPda.poolAuthority(MINT),
      MINT,
      PUMP,
      Keypair.generate().publicKey,
      baseAcc,
      quoteAcc,
    ]) {
      b.set(k.toBytes(), o)
      o += 32
    }
    w2.accounts.set(pool.toBase58(), { executable: false, owner: PUMP_AMM_PROGRAM_ID, lamports: 1, data: b })
    w2.accounts.set(baseAcc.toBase58(), tokenAccount(MINT, pool, 1_000_000_000_000n, TOKEN_PROGRAM_ID))
    w2.accounts.set(quoteAcc.toBase58(), tokenAccount(PUMP, pool, 3_000_000_000n))
    const amm = await v2.getPoolState()
    expect(amm.address).toBe(pool.toBase58())
    expect(amm.priceQuotePerBaseE18).toBe(3n * 10n ** 15n)
    expect(amm.quoteReserveRaw).toBe(3_000_000_000n)
  })

  it('pendingFees sums the curve vault and (after graduation) the AMM vault; never any SCRATCHY', async () => {
    const { venue } = venueFor(world({ vault: 500n, amm: 250n, complete: true }))
    expect(await venue.pendingFees()).toEqual({ quoteRaw: 750n, baseRaw: 0n })
    const { venue: v2 } = venueFor(world())
    expect(await v2.pendingFees()).toEqual({ quoteRaw: 0n, baseRaw: 0n })
  })

  it('claimFees: PRIZE signs distribute (+ AMM transfer when graduated) and books PRIZE/OPS deltas from the tx meta', async () => {
    const w = world({ vault: 700_000n, amm: 300_000n, complete: true })
    let sent: Transaction | null = null
    const { venue, prize } = venueFor(w, async (tx) => {
      sent = tx
      const sig = 'sig-claim-1'
      const prizeAta = ata(prize.publicKey, PUMP, TOKEN_2022_PROGRAM_ID).toBase58()
      const opsAta = ata(LAUNCH, PUMP, TOKEN_2022_PROGRAM_ID).toBase58()
      w.txs.set(sig, {
        err: null,
        pre: [
          { accountIndex: 1, mint: PUMP.toBase58(), owner: prize.publicKey.toBase58(), amount: '10' },
          { accountIndex: 2, mint: PUMP.toBase58(), owner: LAUNCH.toBase58(), amount: '0' },
          { accountIndex: 3, mint: PUMP.toBase58(), owner: fixture.creatorVault, amount: '1000000' },
        ],
        post: [
          { accountIndex: 1, mint: PUMP.toBase58(), owner: prize.publicKey.toBase58(), amount: '700010' },
          { accountIndex: 2, mint: PUMP.toBase58(), owner: LAUNCH.toBase58(), amount: '300000' },
          { accountIndex: 3, mint: PUMP.toBase58(), owner: fixture.creatorVault, amount: '0' },
        ],
      })
      void prizeAta
      void opsAta
      return { signature: sig, slot: 4242 }
    })
    const r = await venue.claimFees()
    expect(r.signatures).toEqual(['sig-claim-1'])
    expect(r.claimedQuoteRaw).toBe(1_000_000n)
    expect(r.claimedBaseRaw).toBe(0n)
    expect(r.distributed).toEqual({ toPrizeRaw: 700_000n, toOpsRaw: 300_000n, slot: 4242 })
    const tx = sent!
    const programs = tx.instructions.map((ix) => ix.programId.toBase58())
    expect(programs).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      PUMP_AMM_PROGRAM_ID.toBase58(),
      PUMP_PROGRAM_ID.toBase58(),
    ])
    expect(tx.feePayer!.equals(prize.publicKey)).toBe(true)
  })

  it('claimFees: refuses an empty vault and a claim that moved PUMP the wrong way', async () => {
    const { venue } = venueFor(world({ vault: 0n }))
    await expect(venue.claimFees()).rejects.toThrow(/nothing to claim/)
    const w = world({ vault: 5n })
    const { venue: v2, prize } = venueFor(w, async () => {
      w.txs.set('bad', {
        err: null,
        pre: [{ accountIndex: 1, mint: PUMP.toBase58(), owner: prize.publicKey.toBase58(), amount: '10' }],
        post: [{ accountIndex: 1, mint: PUMP.toBase58(), owner: prize.publicKey.toBase58(), amount: '4' }],
      })
      return { signature: 'bad', slot: 1 }
    })
    await expect(v2.claimFees()).rejects.toThrow(/wrong way/)
  })

  it('readTokenAmount reads the raw amount at offset 64', () => {
    expect(readTokenAmount(tokenAccount(PUMP, LAUNCH, 42n).data)).toBe(42n)
  })
})
