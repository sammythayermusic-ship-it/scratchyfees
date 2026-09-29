/**
 * Devnet provisioning for the $SCRATCHY rehearsal (PLAN §8 Phases 2 + 5). DEVNET ONLY: lib.ts refuses
 * any RPC whose genesis hash is not devnet's (LOCALNET=1 admits a loopback test validator, never
 * mainnet/testnet). Idempotent: every step checks the chain and .devnet/state.json first, so a re-run
 * after a crash, a faucet refusal or a dropped tx resumes where it stopped and never double-mints.
 *
 *   pnpm --filter @scratchy/api exec tsx scripts/devnet/setup.ts [--dry-run] [--no-airdrop] [--help]
 *
 * Builds, in order:
 *  1. throwaway keypairs CREATOR, PRIZE, OPS, TRADER, TEST1..3 (+ mint and position-NFT keypairs) in
 *     <repo>/.devnet/keys (JSON byte arrays, 0600, gitignored)
 *  2. SOL: PRIZE ≥ 0.6, CREATOR ≥ 0.3 (+ one-time setup rent), TRADER ≥ 0.3, others ≥ 0.05. Airdropped
 *     into CREATOR in ≤ 1 SOL chunks and distributed; faucet refusal → exact funding instructions, exit 2
 *  3. mints (authority CREATOR, 6 dp): mock-SCRATCHY (classic SPL Token); mock-PUMP (Token-2022 with
 *     MetadataPointer + TokenMetadata and NO transfer hook, so DAMM v2 accepts it without a token badge);
 *     HOOK-TEST (Token-2022 with TransferHook: authority set, program NULL, like real PUMP; + metadata)
 *     for exercising the hook-aware payout path
 *  4. MAIN pool: Meteora DAMM v2 custom pool, tokenA = mock-SCRATCHY, tokenB = mock-PUMP, flat 3% base
 *     fee, collectFeeMode OnlyB (fees accrue only in PUMP), full price range, timestamp activation, CREATOR
 *     owns the position NFT, liquidity permanently locked in the creation tx (isLockLiquidity)
 *  5. SECOND pool: small BothToken pool on the same pair for the SCRATCHY→PUMP swap path. A custom pool
 *     address is derived from the mint pair alone (seeds "cpool" + mints), so a second custom pool on this
 *     pair cannot exist: it uses a public static DAMM v2 config instead (BothToken, flat fee closest to 3%,
 *     full range, no dynamic fee) via createPool. CREATOR owns it; not locked
 *  6. tokens: mock-PUMP prize seed → PRIZE, HOOK-TEST seed → PRIZE, inventory → TRADER, mock-SCRATCHY to
 *     TEST1/2/3 worth ≈ $60 / $600 / $5,000 at the MAIN pool's initial price × mock PUMP $0.0056
 *  7. writes .devnet/state.json and <repo>/.env.devnet (0600, gitignored; contains the PRIZE + CREATOR
 *     devnet keys for the API, never printed), validated with the API's own loadConfig()
 * Prints addresses + Solscan links only, never secrets.
 */
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  CpAmm,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  decodePodAlignedFeeTimeScheduler,
  deriveCustomizablePoolAddress,
  derivePoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  feeNumeratorToBps,
  getBaseFeeModeFromPodAlignedData,
  getFeeTimeSchedulerParams,
} from '@meteora-ag/cp-amm-sdk'
import {
  ExtensionType,
  LENGTH_SIZE,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferHookInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMinimumBalanceForRentExemptMint,
  getMint,
  getMintLen,
  getTokenMetadata,
  getTransferHook,
} from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js'
import BN from 'bn.js'
import { existsSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { REAL_PUMP_MINT, loadConfig } from '../../src/env'
import {
  E18,
  REPO_ROOT,
  WALLET_NAMES,
  baseRawForUsd,
  connectDevnet,
  envFilePath,
  errMessage,
  explorerUrl,
  fail,
  fmtSol,
  fmtUsdE18,
  formatUnits,
  fundFromFunder,
  getSolBalances,
  loadOrCreateKeypair,
  loadState,
  parseUnits,
  priceE18FromSqrtPrice,
  printSolBudget,
  redactUrl,
  rentExemptLamports,
  saveState,
  secretKeyEnvValue,
  sendAndConfirm,
  statePath,
  tokenAccountBalance,
  usdE18OfBase,
  writeFileAtomic,
  type DevnetConnection,
  type DevnetState,
  type MintRecord,
  type PoolRecord,
  type WalletName,
} from './lib'

// ── parameters ───────────────────────────────────────────────────────────────

const DECIMALS = 6
const UNIT = 10n ** BigInt(DECIMALS)
const MOCK_PUMP_USD = '0.0056'
const MAIN_FEE_BPS = 300

/** minimum SOL per wallet (CREATOR additionally gets the one-time setup cost on top) */
const SOL_MIN: Record<WalletName, bigint> = {
  prize: 600_000_000n,
  creator: 300_000_000n,
  trader: 300_000_000n,
  ops: 50_000_000n,
  test1: 50_000_000n,
  test2: 50_000_000n,
  test3: 50_000_000n,
}

/** pool seeds in whole tokens; 100M : 10M sets the initial price to 0.1 mPUMP per mock-SCRATCHY */
const MAIN_SEED = { base: 100_000_000n, quote: 10_000_000n }
const SECOND_SEED = { base: 1_000_000n, quote: 100_000n }
/** extra whole token minted to CREATOR per side so a 1-unit rounding difference can never fail a deposit */
const LP_DUST = 1n
const TRADER_INVENTORY = { scratchy: 20_000_000n, pump: 5_000_000n }
const HOOK_PRIZE_SEED = 10_000_000n
const DEFAULT_PRIZE_SEED = '50000000'
const TEST_WALLETS: [WalletName, number][] = [
  ['test1', 60],
  ['test2', 600],
  ['test3', 5_000],
]

interface TokenMeta {
  name: string
  symbol: string
  uri: string
}
const PUMP_META: TokenMeta = { name: 'Mock PUMP', symbol: 'mPUMP', uri: '' }
const HOOK_META: TokenMeta = { name: 'Mock PUMP (hook test)', symbol: 'mPUMPH', uri: '' }

/** conservative rent for one DAMM v2 pool creation: pool, position, NFT mint + account, two vaults */
const POOL_RENT_ESTIMATE = 30_000_000n
const TX_FEE_ALLOWANCE = 20_000n

/** Token-2022 extensions that change transfer semantics; a mock mint must never carry them */
const BLOCKING_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.TransferFeeConfig,
  ExtensionType.PermanentDelegate,
  ExtensionType.DefaultAccountState,
  ExtensionType.NonTransferable,
  ExtensionType.ConfidentialTransferMint,
])

// ── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `devnet setup: provisions keys, SOL, mock mints, DAMM v2 pools and .env.devnet (DEVNET ONLY)

  pnpm --filter @scratchy/api exec tsx scripts/devnet/setup.ts [options]

  --dry-run                 load/create keys, print the SOL budget and the plan; send nothing
  --no-airdrop              never ask the faucet; print exact funding instructions (exit 2) if short
  --skip-second-pool        do not create the BothToken swap-path pool
  --second-pool-config <a>  use this public static DAMM v2 config for the second pool
  --prize-seed <mPUMP>      mock-PUMP minted to PRIZE on the first run (default ${DEFAULT_PRIZE_SEED})
  --new-deploy-id           mint a fresh DEPLOY_ID (e.g. after resetting the database)
  -h, --help

env: RPC_URL (default https://api.devnet.solana.com), LOCALNET=1 (loopback test validator only),
     DEVNET_PRIORITY_MICROLAMPORTS (default 5000)
exit codes: 0 ok · 1 error / refused cluster · 2 manual SOL funding needed`

function parseCli() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'no-airdrop': { type: 'boolean', default: false },
      'skip-second-pool': { type: 'boolean', default: false },
      'second-pool-config': { type: 'string' },
      'prize-seed': { type: 'string', default: DEFAULT_PRIZE_SEED },
      'new-deploy-id': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  })
  let secondPoolConfig: PublicKey | null = null
  if (values['second-pool-config']) {
    try {
      secondPoolConfig = new PublicKey(values['second-pool-config'])
    } catch {
      return fail('--second-pool-config is not a valid address')
    }
  }
  let prizeSeedRaw: bigint
  try {
    prizeSeedRaw = parseUnits(values['prize-seed'], DECIMALS)
  } catch (e) {
    return fail(`--prize-seed: ${errMessage(e)}`)
  }
  return {
    dryRun: values['dry-run'],
    noAirdrop: values['no-airdrop'],
    skipSecondPool: values['skip-second-pool'],
    secondPoolConfig,
    prizeSeedRaw,
    newDeployId: values['new-deploy-id'],
    help: values.help,
  }
}

type Cli = ReturnType<typeof parseCli>

interface Ctx {
  net: DevnetConnection
  conn: Connection
  state: DevnetState
  cpAmm: CpAmm
  wallets: Record<WalletName, Keypair>
  creator: Keypair
  cli: Cli
}

const bn = (v: bigint) => new BN(v.toString())
const big = (v: BN) => BigInt(v.toString())
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`
const fmtTok = (raw: bigint) => formatUnits(raw, DECIMALS)

function step(title: string): void {
  console.log(`\n── ${title}`)
}

// ── keys ─────────────────────────────────────────────────────────────────────

function loadWallets(state: DevnetState): Record<WalletName, Keypair> {
  const wallets = {} as Record<WalletName, Keypair>
  for (const name of WALLET_NAMES) {
    const { keypair, created } = loadOrCreateKeypair(name)
    const address = keypair.publicKey.toBase58()
    const recorded = state.wallets[name]
    if (recorded && recorded !== address) {
      return fail(
        `.devnet/keys/${name}.json holds ${address} but state.json recorded ${recorded} for ${name.toUpperCase()}. ` +
          'Restore the original key file, or move state.json aside to provision from scratch.',
      )
    }
    state.wallets[name] = address
    wallets[name] = keypair
    console.log(`  ${name.toUpperCase().padEnd(8)} ${address}${created ? '  (new)' : ''}`)
  }
  return wallets
}

// ── setup cost estimate ──────────────────────────────────────────────────────

function tokenMetadataLen(meta: TokenMeta): number {
  const b = (s: string) => Buffer.byteLength(s, 'utf8')
  // borsh TokenMetadata: update_authority 32 · mint 32 · name/symbol/uri (u32 len + bytes) · additional (u32)
  return 32 + 32 + 4 + b(meta.name) + 4 + b(meta.symbol) + 4 + b(meta.uri) + 4
}

function token2022MintSpace(hook: boolean): { mintLen: number; total: number } {
  const exts = hook ? [ExtensionType.TransferHook, ExtensionType.MetadataPointer] : [ExtensionType.MetadataPointer]
  const mintLen = getMintLen(exts)
  const meta = hook ? HOOK_META : PUMP_META
  return { mintLen, total: mintLen + TYPE_SIZE + LENGTH_SIZE + tokenMetadataLen(meta) }
}

/** lamports CREATOR still needs for the remaining one-time work (rent + fees), with a 25% margin */
function estimateSetupLamports(state: DevnetState, cli: Cli): { lamports: bigint; lines: string[] } {
  const items: [string, bigint][] = []
  let txs = 0
  if (!state.mints.scratchy) items.push(['mock-SCRATCHY mint', rentExemptLamports(MINT_SIZE)])
  if (!state.mints.pump) items.push(['mock-PUMP mint + metadata', rentExemptLamports(token2022MintSpace(false).total)])
  if (!state.mints.hook) items.push(['HOOK-TEST mint + metadata', rentExemptLamports(token2022MintSpace(true).total)])
  txs += items.length
  const pending = (key: string) => !state.distributions[key]
  const ataRents: bigint[] = []
  if (!state.pools.main) {
    ataRents.push(rentExemptLamports(165), rentExemptLamports(170)) // CREATOR SCRATCHY + mPUMP accounts
    items.push(['MAIN pool (pool, position, NFT, vaults)', POOL_RENT_ESTIMATE])
    txs += 3
  }
  if (!state.pools.second && !cli.skipSecondPool) {
    items.push(['SECOND pool (pool, position, NFT, vaults)', POOL_RENT_ESTIMATE])
    txs += 3
  }
  if (pending('pump:prize')) ataRents.push(rentExemptLamports(170))
  if (pending('hook:prize')) ataRents.push(rentExemptLamports(175)) // + TransferHookAccount
  if (pending('scratchy:trader')) ataRents.push(rentExemptLamports(165))
  if (pending('pump:trader')) ataRents.push(rentExemptLamports(170))
  for (const [name] of TEST_WALLETS) if (pending(`scratchy:${name}`)) ataRents.push(rentExemptLamports(165))
  txs += ataRents.length
  if (ataRents.length) items.push([`${ataRents.length} token accounts`, ataRents.reduce((a, b) => a + b, 0n)])
  items.push([`~${txs + 2} transaction fees`, BigInt(txs + 2) * TX_FEE_ALLOWANCE])
  const raw = items.reduce((s, [, v]) => s + v, 0n)
  const withMargin = (raw * 125n) / 100n
  const step = 10_000_000n // round up to 0.01 SOL
  const lamports = raw === 0n ? 0n : ((withMargin + step - 1n) / step) * step
  const lines = items.map(([k, v]) => `${k}: ${fmtSol(v)}`)
  return { lamports, lines }
}

// ── mints ────────────────────────────────────────────────────────────────────

async function ensureClassicMint(ctx: Ctx, mintKp: Keypair): Promise<MintRecord> {
  const { conn, creator } = ctx
  const mint = mintKp.publicKey
  const existing = await conn.getAccountInfo(mint, 'confirmed')
  let signature: string | null = null
  if (!existing) {
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: creator.publicKey,
        newAccountPubkey: mint,
        space: MINT_SIZE,
        lamports: await getMinimumBalanceForRentExemptMint(conn),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint, DECIMALS, creator.publicKey, null, TOKEN_PROGRAM_ID),
    )
    signature = await sendAndConfirm(conn, tx, [creator, mintKp], { label: 'create mock-SCRATCHY mint' })
  } else if (!existing.owner.equals(TOKEN_PROGRAM_ID)) {
    return fail(`mock-SCRATCHY address ${mint.toBase58()} exists but is not an SPL Token mint`)
  }
  const info = await getMint(conn, mint, 'confirmed', TOKEN_PROGRAM_ID)
  if (info.decimals !== DECIMALS || !info.mintAuthority?.equals(creator.publicKey)) {
    return fail(`mock-SCRATCHY ${mint.toBase58()} has unexpected decimals or mint authority`)
  }
  console.log(`  mock-SCRATCHY ${mint.toBase58()} (SPL Token, ${DECIMALS} dp)${signature ? '' : '  (existing)'}`)
  return { address: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), decimals: DECIMALS, extensions: [], signature }
}

async function ensureToken2022Mint(
  ctx: Ctx,
  label: string,
  mintKp: Keypair,
  opts: { meta: TokenMeta; hook: boolean },
): Promise<MintRecord> {
  const { conn, creator } = ctx
  const mint = mintKp.publicKey
  const existing = await conn.getAccountInfo(mint, 'confirmed')
  let signature: string | null = null
  if (!existing) {
    const { mintLen, total } = token2022MintSpace(opts.hook)
    // space = the fixed extensions only; token-metadata initialize reallocs into the prepaid lamports
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: creator.publicKey,
        newAccountPubkey: mint,
        space: mintLen,
        lamports: await conn.getMinimumBalanceForRentExemption(total),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
    )
    if (opts.hook) {
      // authority set, program id all-zero = None: the hook exists but executes nothing (real PUMP today)
      tx.add(createInitializeTransferHookInstruction(mint, creator.publicKey, PublicKey.default, TOKEN_2022_PROGRAM_ID))
    }
    tx.add(
      createInitializeMetadataPointerInstruction(mint, creator.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      createInitializeMint2Instruction(mint, DECIMALS, creator.publicKey, null, TOKEN_2022_PROGRAM_ID),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: creator.publicKey,
        mint,
        mintAuthority: creator.publicKey,
        name: opts.meta.name,
        symbol: opts.meta.symbol,
        uri: opts.meta.uri,
      }),
    )
    signature = await sendAndConfirm(conn, tx, [creator, mintKp], { label: `create ${label} mint` })
  } else if (!existing.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return fail(`${label} address ${mint.toBase58()} exists but is not a Token-2022 mint`)
  }

  const info = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID)
  if (info.decimals !== DECIMALS || !info.mintAuthority?.equals(creator.publicKey)) {
    return fail(`${label} ${mint.toBase58()} has unexpected decimals or mint authority`)
  }
  const exts = getExtensionTypes(info.tlvData)
  const names = exts.map((e) => ExtensionType[e] ?? `Unknown(${e})`)
  const blocking = exts.filter((e) => BLOCKING_EXTENSIONS.has(e))
  if (blocking.length) return fail(`${label} carries blocking extensions: ${names.join(', ')}`)
  if (!exts.includes(ExtensionType.MetadataPointer) || !exts.includes(ExtensionType.TokenMetadata)) {
    return fail(`${label} is missing MetadataPointer/TokenMetadata (has: ${names.join(', ') || 'none'})`)
  }
  const hook = getTransferHook(info)
  if (opts.hook) {
    if (!hook) return fail(`${label} has no TransferHook extension`)
    if (!hook.programId.equals(PublicKey.default)) {
      return fail(`${label} transfer-hook program must be unset, found ${hook.programId.toBase58()}`)
    }
    if (!hook.authority.equals(creator.publicKey)) return fail(`${label} transfer-hook authority is not CREATOR`)
  } else if (hook) {
    return fail(`${label} must NOT carry a TransferHook (Meteora DAMM v2 would require a token badge)`)
  }
  const meta = await getTokenMetadata(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID)
  if (meta?.symbol !== opts.meta.symbol) return fail(`${label} metadata symbol is ${meta?.symbol ?? 'missing'}`)
  console.log(
    `  ${label.padEnd(13)} ${mint.toBase58()} (Token-2022, ${DECIMALS} dp: ${names.join(', ')})` +
      `${signature ? '' : '  (existing)'}`,
  )
  return {
    address: mint.toBase58(),
    program: TOKEN_2022_PROGRAM_ID.toBase58(),
    decimals: DECIMALS,
    extensions: names,
    signature,
  }
}

// ── token top-ups ────────────────────────────────────────────────────────────

/** Mint just enough to bring `owner`'s ATA up to `targetRaw` (creating the ATA idempotently). */
async function topUp(ctx: Ctx, rec: MintRecord, owner: PublicKey, targetRaw: bigint, label: string) {
  const { conn, creator } = ctx
  const mint = new PublicKey(rec.address)
  const program = new PublicKey(rec.program)
  const ata = getAssociatedTokenAddressSync(mint, owner, false, program)
  const before = await tokenAccountBalance(conn, ata, program)
  if (before >= targetRaw) return { signature: null, minted: 0n, balance: before }
  const minted = targetRaw - before
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, ata, owner, mint, program),
    createMintToCheckedInstruction(mint, ata, creator.publicKey, minted, rec.decimals, [], program),
  )
  const signature = await sendAndConfirm(conn, tx, [creator], { label })
  return { signature, minted, balance: targetRaw }
}

/** One-time top-up recorded under `key`; a recorded key is never topped up again (balances may be spent). */
async function ensureDistribution(
  ctx: Ctx,
  key: string,
  rec: MintRecord,
  symbol: string,
  wallet: WalletName,
  targetRaw: bigint,
): Promise<void> {
  const done = ctx.state.distributions[key]
  if (done) {
    console.log(`  ${wallet.toUpperCase().padEnd(8)} ${symbol.padEnd(14)} done earlier (target ${fmtTok(BigInt(done.targetRaw))})`)
    return
  }
  const owner = ctx.wallets[wallet].publicKey
  const r = await topUp(ctx, rec, owner, targetRaw, `${symbol} → ${wallet.toUpperCase()}`)
  ctx.state.distributions[key] = {
    mint: rec.address,
    owner: owner.toBase58(),
    targetRaw: targetRaw.toString(),
    signature: r.signature,
  }
  saveState(ctx.state)
  console.log(
    `  ${wallet.toUpperCase().padEnd(8)} ${symbol.padEnd(14)} ${fmtTok(r.balance)}` +
      `${r.minted > 0n ? ` (+${fmtTok(r.minted)})` : ' (already held)'}`,
  )
}

// ── pools ────────────────────────────────────────────────────────────────────

/** flat fee in bps for a time-scheduler base fee that never decays; null for anything else */
function flatFeeBps(data: number[]): number | null {
  let mode: BaseFeeMode
  try {
    mode = getBaseFeeModeFromPodAlignedData(data)
  } catch {
    return null
  }
  if (mode !== BaseFeeMode.FeeTimeSchedulerLinear && mode !== BaseFeeMode.FeeTimeSchedulerExponential) return null
  const ts = decodePodAlignedFeeTimeScheduler(Buffer.from(data))
  const flat = ts.numberOfPeriod === 0 || ts.reductionFactor.isZero()
  return flat ? feeNumeratorToBps(ts.cliffFeeNumerator) : null
}

interface ConfigChoice {
  address: PublicKey
  feeBps: number
  index: bigint
}

/** public static configs (no creator authority, no vault) with BothToken, flat fee, full range, no dynamic fee */
async function pickSecondPoolConfig(cpAmm: CpAmm): Promise<ConfigChoice | null> {
  const configs = await cpAmm.getStaticConfigs()
  const candidates: ConfigChoice[] = []
  for (const { publicKey, account } of configs) {
    if (account.collectFeeMode !== CollectFeeMode.BothToken) continue
    if (account.poolFees.dynamicFee.initialized !== 0) continue
    if (!account.sqrtMinPrice.eq(MIN_SQRT_PRICE) || !account.sqrtMaxPrice.eq(MAX_SQRT_PRICE)) continue
    const feeBps = flatFeeBps(account.poolFees.baseFee.data)
    if (feeBps === null) continue
    candidates.push({ address: publicKey, feeBps, index: big(account.index) })
  }
  candidates.sort(
    (a, b) =>
      Math.abs(a.feeBps - MAIN_FEE_BPS) - Math.abs(b.feeBps - MAIN_FEE_BPS) ||
      (a.index < b.index ? -1 : a.index > b.index ? 1 : 0),
  )
  console.log(`  ${configs.length} public static configs, ${candidates.length} usable (BothToken, flat, full range)`)
  return candidates[0] ?? null
}

/** A crashed run may have created the pool without recording it: adopt CREATOR's position in it. */
async function adoptExistingPosition(ctx: Ctx, pool: PublicKey, nftMint: PublicKey) {
  const mine = await ctx.cpAmm.getUserPositionByPool(pool, ctx.creator.publicKey)
  const expected = derivePositionAddress(nftMint)
  const hit = mine.find((p) => p.position.equals(expected)) ?? mine[0]
  if (!hit) {
    return fail(
      `pool ${pool.toBase58()} already exists but CREATOR holds no position in it; ` +
        'cannot adopt it. Move .devnet/state.json and the mint-*.json keys aside to provision fresh mints.',
    )
  }
  console.log(`  pool ${pool.toBase58()} already exists; adopting CREATOR position ${hit.position.toBase58()}`)
  return { position: hit.position, nftMint: hit.positionState.nftMint }
}

async function readPoolRecord(
  ctx: Ctx,
  args: {
    pool: PublicKey
    kind: PoolRecord['kind']
    config: PublicKey | null
    position: PublicKey
    nftMint: PublicKey
    seedBaseRaw: bigint
    seedQuoteRaw: bigint
    initSqrtPrice: bigint | null
    signature: string | null
  },
): Promise<PoolRecord> {
  const { cpAmm, creator } = ctx
  const ps = await cpAmm.fetchPoolState(args.pool)
  const pos = await cpAmm.fetchPositionState(args.position)
  const mode =
    ps.collectFeeMode === CollectFeeMode.OnlyB
      ? 'OnlyB'
      : ps.collectFeeMode === CollectFeeMode.BothToken
        ? 'BothToken'
        : fail(`pool ${args.pool.toBase58()} has unexpected collectFeeMode ${ps.collectFeeMode}`)
  const owned = await cpAmm.getUserPositionByPool(args.pool, creator.publicKey)
  if (!owned.some((p) => p.position.equals(args.position))) {
    return fail(`position ${args.position.toBase58()} is not held by CREATOR`)
  }
  const sqrt = args.initSqrtPrice ?? big(ps.sqrtPrice)
  return {
    address: args.pool.toBase58(),
    kind: args.kind,
    config: args.config?.toBase58() ?? null,
    collectFeeMode: mode,
    feeBps: flatFeeBps(ps.poolFees.baseFee.baseFeeInfo.data) ?? -1,
    tokenAMint: ps.tokenAMint.toBase58(),
    tokenBMint: ps.tokenBMint.toBase58(),
    tokenAVault: ps.tokenAVault.toBase58(),
    tokenBVault: ps.tokenBVault.toBase58(),
    position: args.position.toBase58(),
    positionNftMint: args.nftMint.toBase58(),
    positionNftAccount: derivePositionNftAccount(args.nftMint).toBase58(),
    owner: creator.publicKey.toBase58(),
    permanentlyLocked: cpAmm.isPermanentLockedPosition(pos),
    seedBaseRaw: args.seedBaseRaw.toString(),
    seedQuoteRaw: args.seedQuoteRaw.toString(),
    initSqrtPrice: sqrt.toString(),
    initPriceQuotePerBaseE18: priceE18FromSqrtPrice(sqrt, DECIMALS, DECIMALS).toString(),
    signature: args.signature,
  }
}

async function verifyRecordedPool(ctx: Ctx, rec: PoolRecord, label: string): Promise<PoolRecord> {
  if (!(await ctx.cpAmm.isPoolExist(new PublicKey(rec.address)))) {
    return fail(
      `state.json records the ${label} pool ${rec.address} but it is not on-chain (cluster reset?). ` +
        'Move .devnet/state.json aside to provision from scratch.',
    )
  }
  console.log(`  ${label} pool ${rec.address} (existing)`)
  return rec
}

async function ensureMainPool(ctx: Ctx, scratchy: MintRecord, pump: MintRecord, nft: Keypair): Promise<PoolRecord> {
  const { state, cpAmm, conn, creator } = ctx
  if (state.pools.main) return verifyRecordedPool(ctx, state.pools.main, 'MAIN')
  const tokenAMint = new PublicKey(scratchy.address)
  const tokenBMint = new PublicKey(pump.address)
  const pool = deriveCustomizablePoolAddress(tokenAMint, tokenBMint)
  const seedBase = MAIN_SEED.base * UNIT
  const seedQuote = MAIN_SEED.quote * UNIT

  let position: PublicKey
  let nftMint: PublicKey
  let signature: string | null = null
  let initSqrtPrice: bigint | null = null
  if (await cpAmm.isPoolExist(pool)) {
    ;({ position, nftMint } = await adoptExistingPosition(ctx, pool, nft.publicKey))
  } else {
    await topUp(ctx, scratchy, creator.publicKey, seedBase + LP_DUST * UNIT, 'mock-SCRATCHY → CREATOR (MAIN liquidity)')
    await topUp(ctx, pump, creator.publicKey, seedQuote + LP_DUST * UNIT, 'mock-PUMP → CREATOR (MAIN liquidity)')
    const prepared = cpAmm.preparePoolCreationParams({
      tokenAAmount: bn(seedBase),
      tokenBAmount: bn(seedQuote),
      minSqrtPrice: MIN_SQRT_PRICE,
      maxSqrtPrice: MAX_SQRT_PRICE,
      collectFeeMode: CollectFeeMode.OnlyB,
    })
    const built = await cpAmm.createCustomPool({
      payer: creator.publicKey,
      creator: creator.publicKey,
      positionNft: nft.publicKey,
      tokenAMint,
      tokenBMint,
      tokenAAmount: bn(seedBase),
      tokenBAmount: bn(seedQuote),
      sqrtMinPrice: MIN_SQRT_PRICE,
      sqrtMaxPrice: MAX_SQRT_PRICE,
      liquidityDelta: prepared.liquidityDelta,
      initSqrtPrice: prepared.initSqrtPrice,
      poolFees: {
        // flat 3%: start = end = 300 bps, no periods
        baseFee: getFeeTimeSchedulerParams(MAIN_FEE_BPS, MAIN_FEE_BPS, BaseFeeMode.FeeTimeSchedulerLinear, 0, 0),
        compoundingFeeBps: 0,
        padding: 0,
        dynamicFee: null,
      },
      hasAlphaVault: false,
      activationType: ActivationType.Timestamp,
      collectFeeMode: CollectFeeMode.OnlyB,
      activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_2022_PROGRAM_ID,
      isLockLiquidity: true,
    })
    if (!built.pool.equals(pool)) return fail(`SDK pool address ${built.pool.toBase58()} ≠ derived ${pool.toBase58()}`)
    signature = await sendAndConfirm(conn, built.tx, [creator, nft], {
      label: 'create MAIN DAMM v2 pool',
      priorityMicroLamports: 0, // keep the legacy tx well under the size limit
    })
    position = built.position
    nftMint = nft.publicKey
    initSqrtPrice = big(prepared.initSqrtPrice)
  }

  const rec = await readPoolRecord(ctx, {
    pool,
    kind: 'custom',
    config: null,
    position,
    nftMint,
    seedBaseRaw: seedBase,
    seedQuoteRaw: seedQuote,
    initSqrtPrice,
    signature,
  })
  if (rec.collectFeeMode !== 'OnlyB') return fail('MAIN pool must collect fees OnlyB')
  if (rec.feeBps !== MAIN_FEE_BPS) return fail(`MAIN pool fee is ${rec.feeBps} bps, expected ${MAIN_FEE_BPS}`)
  if (!rec.permanentlyLocked) return fail('MAIN pool position is not permanently locked')
  if (rec.tokenAMint !== scratchy.address || rec.tokenBMint !== pump.address) {
    return fail('MAIN pool token order must be A = mock-SCRATCHY, B = mock-PUMP')
  }
  state.pools.main = rec
  saveState(state)
  console.log(`  MAIN pool ${rec.address}  position ${rec.position}  (3% OnlyB, locked)`)
  return rec
}

async function ensureSecondPool(ctx: Ctx, scratchy: MintRecord, pump: MintRecord, nft: Keypair) {
  const { state, cpAmm, conn, creator, cli } = ctx
  if (state.pools.second) return verifyRecordedPool(ctx, state.pools.second, 'SECOND')

  let config: PublicKey
  if (state.secondPoolConfig) {
    config = new PublicKey(state.secondPoolConfig)
  } else if (cli.secondPoolConfig) {
    config = cli.secondPoolConfig
  } else {
    const choice = await pickSecondPoolConfig(cpAmm)
    if (!choice) {
      console.warn('  ! no public static BothToken config found; SECOND pool skipped (swap path untestable on-chain)')
      return null
    }
    config = choice.address
    console.log(`  chose config ${config.toBase58()} (index ${choice.index}, ${choice.feeBps} bps flat)`)
  }
  const cfg = await cpAmm.fetchConfigState(config)
  if (
    cfg.configType !== 0 ||
    !cfg.poolCreatorAuthority.equals(PublicKey.default) ||
    !cfg.vaultConfigKey.equals(PublicKey.default)
  ) {
    return fail(`config ${config.toBase58()} is not a public static config`)
  }
  if (cfg.collectFeeMode !== CollectFeeMode.BothToken) {
    return fail(`config ${config.toBase58()} collects fees in mode ${cfg.collectFeeMode}, need BothToken (0)`)
  }
  state.secondPoolConfig = config.toBase58() // pin before sending, so a re-run targets the same pool
  saveState(state)

  const tokenAMint = new PublicKey(scratchy.address)
  const tokenBMint = new PublicKey(pump.address)
  const pool = derivePoolAddress(config, tokenAMint, tokenBMint)
  const seedBase = SECOND_SEED.base * UNIT
  const seedQuote = SECOND_SEED.quote * UNIT
  let position: PublicKey
  let nftMint: PublicKey
  let signature: string | null = null
  let initSqrtPrice: bigint | null = null
  if (await cpAmm.isPoolExist(pool)) {
    ;({ position, nftMint } = await adoptExistingPosition(ctx, pool, nft.publicKey))
  } else {
    await topUp(ctx, scratchy, creator.publicKey, seedBase + LP_DUST * UNIT, 'mock-SCRATCHY → CREATOR (SECOND liquidity)')
    await topUp(ctx, pump, creator.publicKey, seedQuote + LP_DUST * UNIT, 'mock-PUMP → CREATOR (SECOND liquidity)')
    const prepared = cpAmm.preparePoolCreationParams({
      tokenAAmount: bn(seedBase),
      tokenBAmount: bn(seedQuote),
      minSqrtPrice: cfg.sqrtMinPrice,
      maxSqrtPrice: cfg.sqrtMaxPrice,
      collectFeeMode: CollectFeeMode.BothToken,
    })
    const tx = await cpAmm.createPool({
      payer: creator.publicKey,
      creator: creator.publicKey,
      config,
      positionNft: nft.publicKey,
      tokenAMint,
      tokenBMint,
      initSqrtPrice: prepared.initSqrtPrice,
      liquidityDelta: prepared.liquidityDelta,
      tokenAAmount: bn(seedBase),
      tokenBAmount: bn(seedQuote),
      activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_2022_PROGRAM_ID,
      isLockLiquidity: false,
    })
    signature = await sendAndConfirm(conn, tx, [creator, nft], {
      label: 'create SECOND DAMM v2 pool',
      priorityMicroLamports: 0,
    })
    position = derivePositionAddress(nft.publicKey)
    nftMint = nft.publicKey
    initSqrtPrice = big(prepared.initSqrtPrice)
  }
  const rec = await readPoolRecord(ctx, {
    pool,
    kind: 'config',
    config,
    position,
    nftMint,
    seedBaseRaw: seedBase,
    seedQuoteRaw: seedQuote,
    initSqrtPrice,
    signature,
  })
  if (rec.collectFeeMode !== 'BothToken') return fail('SECOND pool must collect fees in BothToken mode')
  state.pools.second = rec
  saveState(state)
  const fee = rec.feeBps >= 0 ? `${(rec.feeBps / 100).toFixed(2)}%` : 'non-flat fee'
  console.log(`  SECOND pool ${rec.address}  position ${rec.position}  (${fee} BothToken, unlocked)`)
  return rec
}

// ── .env.devnet ──────────────────────────────────────────────────────────────

const ENV_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_LINE.exec(line)
    if (!m || line.trimStart().startsWith('#')) continue
    const key = m[1] as string
    let value = (m[2] ?? '').trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    out.set(key, value)
  }
  return out
}

function buildEnvFile(ctx: Ctx, mints: { scratchy: MintRecord; pump: MintRecord; hook: MintRecord }, main: PoolRecord, second: PoolRecord | null): string {
  const { state, net, wallets } = ctx
  const managed: [string, string][] = [
    ['CHAIN_MODE', 'solana'],
    ['SOLANA_CLUSTER', net.cluster],
    ['RPC_URL', net.rpcUrl],
    ['DEPLOY_ID', state.deployId ?? 'devnet'],
    ['PUMP_MINT', mints.pump.address],
    ['PUMP_PRICE_MINT', REAL_PUMP_MINT],
    ['SCRATCHY_MINT', mints.scratchy.address],
    ['PRIZE_WALLET_KEY', secretKeyEnvValue(wallets.prize)],
    ['PRIZE_WALLET_ADDRESS', wallets.prize.publicKey.toBase58()],
    ['CREATOR_WALLET_KEY', secretKeyEnvValue(wallets.creator)],
    ['CREATOR_WALLET_ADDRESS', wallets.creator.publicKey.toBase58()],
    ['OPS_WALLET_ADDRESS', wallets.ops.publicKey.toBase58()],
    ['VENUE', 'damm-v2'],
    ['VENUE_POOL_ADDRESS', main.address],
    ['VENUE_POSITION_ADDRESS', main.position],
    ['SWAP', 'none'],
    ['PRICE_SOURCE', 'mock'],
    ['MOCK_PUMP_USD', MOCK_PUMP_USD],
  ]
  const extras: [string, string][] = [
    ['HOOK_TEST_MINT', mints.hook.address],
    ['SECOND_POOL_ADDRESS', second?.address ?? ''],
    ['SECOND_POSITION_ADDRESS', second?.position ?? ''],
    ['SECOND_POOL_CONFIG', second?.config ?? ''],
    ['TRADER_WALLET_ADDRESS', wallets.trader.publicKey.toBase58()],
    ['TEST1_WALLET_ADDRESS', wallets.test1.publicKey.toBase58()],
    ['TEST2_WALLET_ADDRESS', wallets.test2.publicKey.toBase58()],
    ['TEST3_WALLET_ADDRESS', wallets.test3.publicKey.toBase58()],
  ]
  const managedKeys = new Set([...managed, ...extras].map(([k]) => k))
  const path = envFilePath(net.cluster)
  const preserved: [string, string][] = []
  if (existsSync(path)) {
    for (const [k, v] of parseEnv(readFileSync(path, 'utf8'))) if (!managedKeys.has(k)) preserved.push([k, v])
  }
  const kv = (rows: [string, string][]) => rows.map(([k, v]) => `${k}=${v}`).join('\n')
  const sections = [
    `# $SCRATCHY ${net.cluster} deployment. Written by apps/api/scripts/devnet/setup.ts at ${new Date().toISOString()}.`,
    '# CONTAINS THROWAWAY DEVNET SECRET KEYS (PRIZE, CREATOR). gitignored (.env.*); never commit, never reuse on mainnet.',
    '# Re-running setup rewrites the managed keys below and keeps any other variables you add.',
    '# Run the API with it:  pnpm --filter @scratchy/api exec node --env-file=../../.env.devnet --import tsx src/main.ts',
    '',
    kv(managed),
    '',
    '# ── extras for smoke/rehearsal scripts (ignored by the API env schema) ──',
    '# Hook-aware payout path: set PUMP_MINT=$HOOK_TEST_MINT (PRIZE holds a HOOK-TEST seed).',
    '# Swap path: point VENUE_POOL_ADDRESS/VENUE_POSITION_ADDRESS at the SECOND (BothToken) pool.',
    kv(extras),
  ]
  if (preserved.length) sections.push('', '# ── preserved from the previous file ──', kv(preserved))
  return `${sections.join('\n')}\n`
}

function validateEnv(content: string): void {
  const vars = Object.fromEntries(parseEnv(content))
  try {
    loadConfig({ ...vars, NODE_ENV: 'development' })
    console.log('  validated with the API loadConfig(): ok')
  } catch (e) {
    console.warn(`  ! the API's loadConfig() rejects this env: ${errMessage(e)}`)
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function deployIdFor(cluster: string, withTime: boolean): string {
  const iso = new Date().toISOString() // 2026-09-29T15:02:03.000Z
  const date = iso.slice(0, 10).replaceAll('-', '')
  const time = iso.slice(11, 19).replaceAll(':', '')
  return `${cluster}-${date}${withTime ? `-${time}` : ''}`
}

async function main(): Promise<void> {
  const cli = parseCli()
  if (cli.help) {
    console.log(HELP)
    return
  }
  console.log('$SCRATCHY devnet setup (DEVNET ONLY)')
  const net = await connectDevnet()
  const { conn, cluster } = net
  const state = loadState(cluster, net.genesisHash)

  step('keys (.devnet/keys, 0600)')
  const wallets = loadWallets(state)
  const creator = wallets.creator
  const mintKeys = {
    scratchy: loadOrCreateKeypair('mint-scratchy').keypair,
    pump: loadOrCreateKeypair('mint-mpump').keypair,
    hook: loadOrCreateKeypair('mint-hook').keypair,
  }
  const nftKeys = {
    main: loadOrCreateKeypair('posnft-main').keypair,
    second: loadOrCreateKeypair('posnft-second').keypair,
  }
  if (!state.deployId || cli.newDeployId) state.deployId = deployIdFor(cluster, cli.newDeployId)
  saveState(state)
  const ctx: Ctx = { net, conn, state, cpAmm: new CpAmm(conn), wallets, creator, cli }

  // budget up front, before anything is spent
  const setup = estimateSetupLamports(state, cli)
  const targets = WALLET_NAMES.map((name) => ({
    label: name.toUpperCase(),
    keypair: wallets[name],
    lamports: SOL_MIN[name] + (name === 'creator' ? setup.lamports : 0n),
  }))
  const balances = await getSolBalances(
    conn,
    targets.map((t) => t.keypair.publicKey),
  )
  const toFund = printSolBudget(
    `${cluster} (${redactUrl(net.rpcUrl)})`,
    targets.map((t, i) => ({
      label: t.label,
      address: t.keypair.publicKey.toBase58(),
      targetLamports: t.lamports,
      balanceLamports: balances[i] ?? 0n,
    })),
    [
      `CREATOR target = ${fmtSol(SOL_MIN.creator)} operating float + ${fmtSol(setup.lamports)} remaining one-time setup (25% margin):`,
      ...setup.lines.map((l) => `    ${l}`),
      'the faucet is asked only for CREATOR (≤ 1 SOL per request, exponential backoff); CREATOR then distributes',
      `if the faucet refuses, the script prints exact amounts for ${FAUCET_HINT} and exits with code 2`,
    ],
  )
  if (cli.dryRun) {
    console.log(`\n--dry-run: nothing sent. ${toFund > 0n ? `${fmtSol(toFund)} still to fund.` : 'SOL is sufficient.'}`)
    printPlan(state, cli)
    return
  }

  step('SOL')
  const [creatorTarget, ...otherTargets] = targets
  if (!creatorTarget) return fail('internal: no CREATOR target')
  await fundFromFunder(conn, creatorTarget, otherTargets, { noAirdrop: cli.noAirdrop })
  console.log('  all wallets at their minimum SOL')

  step('mints (authority CREATOR)')
  const scratchy = (state.mints.scratchy ??= await ensureClassicMint(ctx, mintKeys.scratchy))
  saveState(state)
  const pump = (state.mints.pump ??= await ensureToken2022Mint(ctx, 'mock-PUMP', mintKeys.pump, { meta: PUMP_META, hook: false }))
  saveState(state)
  const hook = (state.mints.hook ??= await ensureToken2022Mint(ctx, 'HOOK-TEST', mintKeys.hook, { meta: HOOK_META, hook: true }))
  saveState(state)

  step('prize + trader balances')
  await ensureDistribution(ctx, 'pump:prize', pump, 'mock-PUMP', 'prize', cli.prizeSeedRaw)
  await ensureDistribution(ctx, 'hook:prize', hook, 'HOOK-TEST', 'prize', HOOK_PRIZE_SEED * UNIT)
  await ensureDistribution(ctx, 'scratchy:trader', scratchy, 'mock-SCRATCHY', 'trader', TRADER_INVENTORY.scratchy * UNIT)
  await ensureDistribution(ctx, 'pump:trader', pump, 'mock-PUMP', 'trader', TRADER_INVENTORY.pump * UNIT)

  step('MAIN pool (DAMM v2 custom: 3% flat, OnlyB, locked, CREATOR-owned)')
  const main = await ensureMainPool(ctx, scratchy, pump, nftKeys.main)

  step('SECOND pool (DAMM v2 static config: BothToken, swap-path exercise)')
  const second = cli.skipSecondPool
    ? (state.pools.second ?? (console.log('  skipped (--skip-second-pool)'), null))
    : await ensureSecondPool(ctx, scratchy, pump, nftKeys.second)

  step(`test wallets (≈ USD at the MAIN pool's initial price × mock PUMP $${MOCK_PUMP_USD})`)
  const priceE18 = BigInt(main.initPriceQuotePerBaseE18)
  const pumpUsdE18 = parseUnits(MOCK_PUMP_USD, 18)
  state.testWallets ??= {}
  for (const [name, usd] of TEST_WALLETS) {
    const amount = baseRawForUsd(BigInt(usd), priceE18, pumpUsdE18, DECIMALS)
    state.testWallets[name] = { usdTarget: usd, scratchyRaw: amount.toString() }
    await ensureDistribution(ctx, `scratchy:${name}`, scratchy, 'mock-SCRATCHY', name, amount)
  }
  saveState(state)

  step('.env')
  const envPath = envFilePath(cluster)
  const content = buildEnvFile(ctx, { scratchy, pump, hook }, main, second)
  writeFileAtomic(envPath, content, 0o600)
  console.log(`  wrote ${relative(REPO_ROOT, envPath)} (0600, gitignored; holds devnet keys, not printed)`)
  validateEnv(content)

  printSummary(ctx, { scratchy, pump, hook }, main, second, priceE18, pumpUsdE18)
}

const FAUCET_HINT = 'https://faucet.solana.com'

function printPlan(state: DevnetState, cli: Cli): void {
  const mark = (done: boolean) => (done ? 'done   ' : 'pending')
  console.log('\nplan:')
  console.log(`  ${mark(!!state.mints.scratchy)} mock-SCRATCHY mint (SPL Token, 6 dp)`)
  console.log(`  ${mark(!!state.mints.pump)} mock-PUMP mint (Token-2022, metadata, no hook)`)
  console.log(`  ${mark(!!state.mints.hook)} HOOK-TEST mint (Token-2022, hook authority set, program unset)`)
  console.log(`  ${mark(!!state.distributions['pump:prize'])} PRIZE ← ${fmtTok(cli.prizeSeedRaw)} mock-PUMP`)
  console.log(`  ${mark(!!state.distributions['hook:prize'])} PRIZE ← ${fmtTok(HOOK_PRIZE_SEED * UNIT)} HOOK-TEST`)
  console.log(
    `  ${mark(!!state.distributions['scratchy:trader'] && !!state.distributions['pump:trader'])} TRADER ← ` +
      `${fmtTok(TRADER_INVENTORY.scratchy * UNIT)} mock-SCRATCHY + ${fmtTok(TRADER_INVENTORY.pump * UNIT)} mock-PUMP`,
  )
  console.log(
    `  ${mark(!!state.pools.main)} MAIN pool ${fmtTok(MAIN_SEED.base * UNIT)} mock-SCRATCHY / ` +
      `${fmtTok(MAIN_SEED.quote * UNIT)} mock-PUMP (3% OnlyB, locked)`,
  )
  console.log(
    `  ${cli.skipSecondPool ? 'skip   ' : mark(!!state.pools.second)} SECOND pool ` +
      `${fmtTok(SECOND_SEED.base * UNIT)} / ${fmtTok(SECOND_SEED.quote * UNIT)} (BothToken, static config)`,
  )
  for (const [name, usd] of TEST_WALLETS) {
    console.log(`  ${mark(!!state.distributions[`scratchy:${name}`])} ${name.toUpperCase()} ← mock-SCRATCHY worth ≈ $${usd}`)
  }
  console.log(`  pending .env / state files: ${relative(REPO_ROOT, statePath(state.cluster))}, ${relative(REPO_ROOT, envFilePath(state.cluster))}`)
}

function printSummary(
  ctx: Ctx,
  mints: { scratchy: MintRecord; pump: MintRecord; hook: MintRecord },
  main: PoolRecord,
  second: PoolRecord | null,
  priceE18: bigint,
  pumpUsdE18: bigint,
): void {
  const { net, wallets, state } = ctx
  const c = net.cluster
  const acct = (a: string) => explorerUrl('account', a, c, net.rpcUrl)
  const tok = (a: string) => explorerUrl('token', a, c, net.rpcUrl)
  const scratchyUsdE18 = (priceE18 * pumpUsdE18) / E18
  console.log(`\n══ ${c.toUpperCase()} READY (deploy ${state.deployId}) ══`)
  console.log('wallets')
  for (const name of WALLET_NAMES) {
    const a = wallets[name].publicKey.toBase58()
    console.log(`  ${name.toUpperCase().padEnd(8)} ${a.padEnd(44)} ${acct(a)}`)
  }
  console.log('mints')
  console.log(`  mock-SCRATCHY ${mints.scratchy.address.padEnd(44)} ${tok(mints.scratchy.address)}`)
  console.log(`  mock-PUMP     ${mints.pump.address.padEnd(44)} ${tok(mints.pump.address)}`)
  console.log(`  HOOK-TEST     ${mints.hook.address.padEnd(44)} ${tok(mints.hook.address)}`)
  console.log('pools')
  for (const [label, p] of [['MAIN', main], ['SECOND', second]] as const) {
    if (!p) {
      console.log(`  ${label.padEnd(8)} (none)`)
      continue
    }
    const fee = p.feeBps >= 0 ? `${(p.feeBps / 100).toFixed(2)}%` : 'non-flat fee'
    console.log(`  ${label.padEnd(8)} pool     ${p.address.padEnd(44)} ${acct(p.address)}`)
    console.log(`  ${''.padEnd(8)} position ${p.position.padEnd(44)} ${acct(p.position)}`)
    console.log(`  ${''.padEnd(8)} NFT      ${p.positionNftMint.padEnd(44)} held by CREATOR ${short(p.owner)}`)
    console.log(`  ${''.padEnd(8)} ${fee} · ${p.collectFeeMode} · ${p.permanentlyLocked ? 'permanently locked' : 'unlocked'}${p.config ? ` · config ${p.config}` : ''}`)
  }
  console.log(
    `price    1 mock-SCRATCHY = ${formatUnits(priceE18, 18, 6)} mPUMP ≈ ${fmtUsdE18E6(scratchyUsdE18)} ` +
      `(mock PUMP $${MOCK_PUMP_USD})`,
  )
  console.log('test wallets')
  for (const [name, usd] of TEST_WALLETS) {
    const raw = BigInt(state.testWallets?.[name]?.scratchyRaw ?? '0')
    const worth = usdE18OfBase(raw, priceE18, pumpUsdE18, DECIMALS)
    console.log(`  ${name.toUpperCase().padEnd(8)} ${fmtTok(raw).padStart(22)} mock-SCRATCHY ≈ ${fmtUsdE18(worth)} (target $${usd})`)
  }
  console.log('files')
  console.log(`  ${relative(REPO_ROOT, statePath(c))}   addresses + progress (no secrets)`)
  console.log(`  ${relative(REPO_ROOT, envFilePath(c))}   API env (0600, gitignored; holds the PRIZE + CREATOR devnet keys)`)
  console.log('next')
  console.log('  fee inflow:  pnpm --filter @scratchy/api exec tsx scripts/devnet/fee-inflow.ts --count 10')
  console.log(`  API:         pnpm --filter @scratchy/api exec node --env-file=../../${relative(REPO_ROOT, envFilePath(c))} --import tsx src/main.ts`)
}

/** USD with 6 decimals (sub-cent token prices) */
function fmtUsdE18E6(usdE18: bigint): string {
  return `$${formatUnits(usdE18, 18, 6)}`
}

main().catch((e: unknown) => fail(errMessage(e)))
