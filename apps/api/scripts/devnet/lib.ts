/**
 * Shared helpers for the devnet provisioning scripts (setup.ts, fee-inflow.ts). DEVNET ONLY.
 *
 * Safety model:
 *  - connectDevnet() returns a connection only when the RPC's genesis hash is devnet's. LOCALNET=1 also
 *    admits a local test validator, but only on a loopback RPC URL and never with the mainnet-beta or
 *    testnet genesis. An RPC URL is only a claim; the genesis hash is what the node actually serves.
 *  - Throwaway keys live in <repo>/.devnet/keys/<name>.json (solana-keygen JSON byte arrays, mode 0600,
 *    gitignored). Nothing here prints a secret key; error messages never echo key-file contents.
 *  - airdropWithBackoff() asks the faucet in ≤ 1 SOL chunks with exponential backoff. If the faucet keeps
 *    refusing, it prints exactly which public keys need how much SOL (https://faucet.solana.com) and
 *    exits with code 2. It never continues underfunded.
 *  - RPC URLs are redacted before printing (providers put API keys in the query string or path).
 * Token amounts are raw base-unit bigints; SOL amounts are lamports (bigint); prices are
 * "quote per whole token × 1e18" bigints, the same convention as src/venue and src/oracle.
 * This module has no side effects on import, so its pure helpers can be exercised without a network.
 */
import { unpackAccount } from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  type Signer,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// ── cluster gate ─────────────────────────────────────────────────────────────

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
/** public clusters these scripts must never touch, even with LOCALNET=1 */
export const FORBIDDEN_GENESIS: Readonly<Record<string, string>> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
}
export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com'
export const FAUCET_URL = 'https://faucet.solana.com'

export type DevnetCluster = 'devnet' | 'localnet'

export type ClusterVerdict = { ok: true; cluster: DevnetCluster } | { ok: false; reason: string }

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** Pure decision: may these scripts run against the node that reported `genesisHash`? */
export function classifyCluster(genesisHash: string, rpcUrl: string, localnetFlag: boolean): ClusterVerdict {
  if (genesisHash === DEVNET_GENESIS_HASH) return { ok: true, cluster: 'devnet' }
  const forbidden = FORBIDDEN_GENESIS[genesisHash]
  if (forbidden) {
    return { ok: false, reason: `the RPC serves ${forbidden} (genesis ${genesisHash}); these scripts are devnet-only` }
  }
  if (!localnetFlag) {
    return {
      ok: false,
      reason: `genesis ${genesisHash} is not devnet (${DEVNET_GENESIS_HASH}); LOCALNET=1 is only for a local test validator`,
    }
  }
  if (!isLoopbackUrl(rpcUrl)) {
    return { ok: false, reason: 'LOCALNET=1 requires RPC_URL on localhost / 127.0.0.1 / [::1]' }
  }
  return { ok: true, cluster: 'localnet' }
}

/** protocol + host only: providers embed API keys in the query string or the path */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname && u.pathname !== '/' ? '/…' : ''
    return `${u.protocol}//${u.host}${path}${u.search ? '?<redacted>' : ''}`
  } catch {
    return '<unparseable RPC_URL>'
  }
}

export interface DevnetConnection {
  conn: Connection
  cluster: DevnetCluster
  genesisHash: string
  /** full RPC URL (may contain an API key): never print it, use redactUrl() */
  rpcUrl: string
}

/** Connect to RPC_URL (default public devnet) and refuse to continue unless the genesis check passes. */
export async function connectDevnet(env: NodeJS.ProcessEnv = process.env): Promise<DevnetConnection> {
  const rpcUrl = env.RPC_URL?.trim() || DEFAULT_RPC_URL
  const conn = new Connection(rpcUrl, { commitment: 'confirmed' })
  let genesisHash: string
  try {
    genesisHash = await conn.getGenesisHash()
  } catch (e) {
    return fail(`cannot reach the RPC at ${redactUrl(rpcUrl)}: ${errMessage(e)}`)
  }
  const verdict = classifyCluster(genesisHash, rpcUrl, env.LOCALNET === '1')
  if (!verdict.ok) return fail(`REFUSING TO RUN: ${verdict.reason}`)
  console.log(`cluster: ${verdict.cluster} (genesis ${genesisHash}) via ${redactUrl(rpcUrl)}`)
  return { conn, cluster: verdict.cluster, genesisHash, rpcUrl }
}

// ── process helpers ──────────────────────────────────────────────────────────

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function fail(message: string, code = 1): never {
  console.error(`\n✖ ${message}`)
  return process.exit(code)
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── paths + key store ────────────────────────────────────────────────────────

/** apps/api/scripts/devnet → repo root */
export const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
export const DEVNET_DIR = resolve(REPO_ROOT, '.devnet')
export const KEYS_DIR = resolve(DEVNET_DIR, 'keys')

export function statePath(cluster: DevnetCluster, dir = DEVNET_DIR): string {
  return join(dir, cluster === 'devnet' ? 'state.json' : 'state.localnet.json')
}

export function envFilePath(cluster: DevnetCluster, root = REPO_ROOT): string {
  return join(root, cluster === 'devnet' ? '.env.devnet' : '.env.localnet')
}

const KEY_NAME = /^[a-z0-9][a-z0-9-]*$/
const SECRET_KEY_BYTES = 64

export function keyPath(name: string, dir = KEYS_DIR): string {
  if (!KEY_NAME.test(name)) throw new Error(`invalid key name "${name}"`)
  return join(dir, `${name}.json`)
}

function readKeyFile(path: string): Keypair {
  const mode = statSync(path).mode & 0o777
  if (mode & 0o077) {
    chmodSync(path, 0o600)
    console.warn(`  tightened permissions of ${path} to 0600 (was ${mode.toString(8)})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`key file ${path} is not valid JSON`) // never echo the contents
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== SECRET_KEY_BYTES ||
    !parsed.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new Error(`key file ${path} must be a JSON array of ${SECRET_KEY_BYTES} byte values`)
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]))
  } catch {
    throw new Error(`key file ${path} does not hold a valid ed25519 secret key`)
  }
}

/** Load `<dir>/<name>.json`, or generate a fresh keypair and write it there (0600, never overwrites). */
export function loadOrCreateKeypair(name: string, dir = KEYS_DIR): { keypair: Keypair; created: boolean } {
  const path = keyPath(name, dir)
  if (existsSync(path)) return { keypair: readKeyFile(path), created: false }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const keypair = Keypair.generate()
  // 'wx' = fail if it appeared meanwhile, so an existing key can never be clobbered
  writeFileSync(path, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, { mode: 0o600, flag: 'wx' })
  return { keypair, created: true }
}

/** Load an existing key; fails (never creates) when it is missing. */
export function loadKeypairFile(name: string, dir = KEYS_DIR): Keypair {
  const path = keyPath(name, dir)
  if (!existsSync(path)) throw new Error(`missing key file ${path}: run setup.ts first`)
  return readKeyFile(path)
}

/** Secret key as the JSON byte array the API accepts. ONLY for writing the 0600 env file; never log it. */
export function secretKeyEnvValue(keypair: Keypair): string {
  return JSON.stringify(Array.from(keypair.secretKey))
}

/** Atomic write (temp file + rename). mode 0600 for anything that may hold secrets. */
export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

// ── state file ───────────────────────────────────────────────────────────────

export const WALLET_NAMES = ['creator', 'prize', 'ops', 'trader', 'test1', 'test2', 'test3'] as const
export type WalletName = (typeof WALLET_NAMES)[number]

export interface MintRecord {
  address: string
  /** SPL Token or Token-2022 program id */
  program: string
  decimals: number
  /** Token-2022 extension names (empty for classic SPL) */
  extensions: string[]
  /** creation tx (null when an existing account was adopted) */
  signature: string | null
}

export interface PoolRecord {
  address: string
  /** 'custom' = initializeCustomizablePool; 'config' = initializePool with a public static config */
  kind: 'custom' | 'config'
  config: string | null
  collectFeeMode: 'OnlyB' | 'BothToken'
  feeBps: number
  /** tokenA = mock-SCRATCHY (base), tokenB = mock-PUMP (quote) */
  tokenAMint: string
  tokenBMint: string
  tokenAVault: string
  tokenBVault: string
  position: string
  positionNftMint: string
  positionNftAccount: string
  /** holder of the position NFT (CREATOR) */
  owner: string
  permanentlyLocked: boolean
  seedBaseRaw: string
  seedQuoteRaw: string
  initSqrtPrice: string
  /** whole mock-PUMP per whole mock-SCRATCHY × 1e18 at creation */
  initPriceQuotePerBaseE18: string
  signature: string | null
}

export interface DistributionRecord {
  mint: string
  owner: string
  /** balance the owner was topped up to (raw) */
  targetRaw: string
  signature: string | null
}

export interface DevnetState {
  version: 1
  cluster: DevnetCluster
  genesisHash: string
  createdAt: string
  updatedAt: string
  deployId: string | null
  wallets: Partial<Record<WalletName, string>>
  mints: { scratchy?: MintRecord; pump?: MintRecord; hook?: MintRecord }
  pools: { main?: PoolRecord; second?: PoolRecord }
  /** static config chosen for the SECOND pool (recorded before creation so re-runs reuse it) */
  secondPoolConfig?: string
  /** one-time token top-ups, keyed "<mint>:<wallet>"; a recorded key is never topped up again */
  distributions: Record<string, DistributionRecord>
  testWallets?: Partial<Record<WalletName, { usdTarget: number; scratchyRaw: string }>>
}

export function emptyState(cluster: DevnetCluster, genesisHash: string): DevnetState {
  const now = new Date().toISOString()
  return {
    version: 1,
    cluster,
    genesisHash,
    createdAt: now,
    updatedAt: now,
    deployId: null,
    wallets: {},
    mints: {},
    pools: {},
    distributions: {},
  }
}

/** Load the state for this cluster; refuses a state written against another genesis (e.g. a devnet reset). */
export function loadState(cluster: DevnetCluster, genesisHash: string, path = statePath(cluster)): DevnetState {
  if (!existsSync(path)) return emptyState(cluster, genesisHash)
  let state: DevnetState
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) as DevnetState
  } catch {
    return fail(`${path} is not valid JSON; fix or move it aside to start fresh`)
  }
  if (state.version !== 1) return fail(`${path}: unsupported state version ${String(state.version)}`)
  if (state.genesisHash !== genesisHash) {
    return fail(
      `${path} was written against genesis ${state.genesisHash} but the RPC serves ${genesisHash} ` +
        '(cluster reset or wrong RPC). Move the file aside to provision from scratch.',
    )
  }
  state.distributions ??= {}
  state.wallets ??= {}
  state.mints ??= {}
  state.pools ??= {}
  return state
}

export function saveState(state: DevnetState, path = statePath(state.cluster)): void {
  state.updatedAt = new Date().toISOString()
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, 0o644)
}

// ── units + prices (bigint only) ─────────────────────────────────────────────

export const LAMPORTS = BigInt(LAMPORTS_PER_SOL)
export const E18 = 10n ** 18n
export const Q128 = 1n << 128n

/** "1234.5" → raw base units; rejects negatives, exponents and excess precision */
export function parseUnits(value: string, decimals: number): bigint {
  const s = value.trim().replaceAll('_', '').replaceAll(',', '')
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a non-negative decimal number: "${value}"`)
  const [whole = '0', frac = ''] = s.split('.')
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimal places`)
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

/** raw → "1,234.5" (fraction truncated to maxFrac digits, trailing zeros trimmed) */
export function formatUnits(raw: bigint, decimals: number, maxFrac = decimals): string {
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

export const fmtSol = (lamports: bigint) => `${formatUnits(lamports, 9, 4)} SOL`
export const fmtUsdE18 = (usdE18: bigint) => `$${formatUnits(usdE18, 18, 2)}`

/** round lamports UP to a 0.01 SOL step (for human funding instructions) */
export function ceilToCentiSol(lamports: bigint): bigint {
  const step = LAMPORTS / 100n
  return ((lamports + step - 1n) / step) * step
}

/**
 * DAMM v2 sqrtPrice (Q64.64 of raw-B per raw-A) → whole-quote per whole-base × 1e18.
 * price_raw = sqrtPrice² / 2^128;  price_whole = price_raw × 10^(decA − decB).
 */
export function priceE18FromSqrtPrice(sqrtPriceX64: bigint, baseDecimals: number, quoteDecimals: number): bigint {
  return (sqrtPriceX64 * sqrtPriceX64 * 10n ** BigInt(18 + baseDecimals)) / (Q128 * 10n ** BigInt(quoteDecimals))
}

/** raw base units worth `usdWhole` dollars at `priceQuotePerBaseE18` × `quoteUsdE18` (floored) */
export function baseRawForUsd(
  usdWhole: bigint,
  priceQuotePerBaseE18: bigint,
  quoteUsdE18: bigint,
  baseDecimals: number,
): bigint {
  if (priceQuotePerBaseE18 <= 0n || quoteUsdE18 <= 0n) throw new Error('prices must be positive')
  return (usdWhole * 10n ** BigInt(baseDecimals) * E18 * E18) / (priceQuotePerBaseE18 * quoteUsdE18)
}

/** USD × 1e18 of `baseRaw` base units */
export function usdE18OfBase(
  baseRaw: bigint,
  priceQuotePerBaseE18: bigint,
  quoteUsdE18: bigint,
  baseDecimals: number,
): bigint {
  return (baseRaw * priceQuotePerBaseE18 * quoteUsdE18) / (10n ** BigInt(baseDecimals) * E18)
}

/** USD × 1e18 of `quoteRaw` quote units */
export function usdE18OfQuote(quoteRaw: bigint, quoteUsdE18: bigint, quoteDecimals: number): bigint {
  return (quoteRaw * quoteUsdE18) / 10n ** BigInt(quoteDecimals)
}

/** rent-exempt minimum for an account of `bytes` data (3480 lamports/byte-year × 2 years, +128 header) */
export function rentExemptLamports(bytes: number): bigint {
  return BigInt((bytes + 128) * 3480 * 2)
}

// ── explorer ─────────────────────────────────────────────────────────────────

export function explorerUrl(
  kind: 'account' | 'tx' | 'token',
  id: string,
  cluster: DevnetCluster,
  localRpcUrl = 'http://127.0.0.1:8899',
): string {
  const q =
    cluster === 'devnet' ? '?cluster=devnet' : `?cluster=custom&customUrl=${encodeURIComponent(localRpcUrl)}`
  return `https://solscan.io/${kind}/${id}${q}`
}

// ── balances ─────────────────────────────────────────────────────────────────

export async function getSolBalances(conn: Connection, keys: PublicKey[]): Promise<bigint[]> {
  const infos = await conn.getMultipleAccountsInfo(keys, 'confirmed')
  return infos.map((i) => BigInt(i?.lamports ?? 0))
}

/** token balance of one token account (0 when it does not exist); works for SPL Token and Token-2022 */
export async function tokenAccountBalance(conn: Connection, account: PublicKey, program: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account, 'confirmed')
  if (!info) return 0n
  return unpackAccount(account, info, program).amount
}

// ── sending ──────────────────────────────────────────────────────────────────

export const DEFAULT_PRIORITY_MICROLAMPORTS = 5_000

export interface SendOptions {
  /** human label for logs and errors */
  label: string
  /** explicit compute-unit limit (omit to keep the runtime default of 200k per instruction) */
  computeUnits?: number
  /** compute-unit price; 0 disables. Default DEVNET_PRIORITY_MICROLAMPORTS or 5,000 µ-lamports */
  priorityMicroLamports?: number
  /** re-broadcast cadence while waiting for confirmation */
  resendMs?: number
}

function defaultPriority(): number {
  const v = Number(process.env.DEVNET_PRIORITY_MICROLAMPORTS ?? DEFAULT_PRIORITY_MICROLAMPORTS)
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_PRIORITY_MICROLAMPORTS
}

async function describeSendError(conn: Connection, e: unknown, label: string): Promise<Error> {
  if (e instanceof SendTransactionError) {
    const logs = e.logs ?? (await e.getLogs(conn).catch(() => [] as string[]))
    const tail = logs.slice(-20).map((l) => `    ${l}`)
    return new Error(`${label}: ${e.message}${tail.length ? `\n  program logs:\n${tail.join('\n')}` : ''}`)
  }
  return new Error(`${label}: ${errMessage(e)}`)
}

/**
 * Sign (first signer pays), simulate via preflight, send, re-broadcast the identical bytes until the
 * signature is confirmed or the blockhash expires. Returns the signature. The instructions are copied
 * into a fresh legacy transaction, so SDK-built transactions need no blockhash/fee payer of their own.
 */
export async function sendAndConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Signer[],
  opts: SendOptions,
): Promise<string> {
  const [payer] = signers
  if (!payer) throw new Error(`${opts.label}: at least one signer (the fee payer) is required`)
  const out = new Transaction()
  const hasBudgetIx = tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
  if (!hasBudgetIx) {
    if (opts.computeUnits) out.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits }))
    const price = opts.priorityMicroLamports ?? defaultPriority()
    if (price > 0) out.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }))
  }
  out.add(...tx.instructions)
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  out.recentBlockhash = blockhash
  out.feePayer = payer.publicKey
  out.sign(...signers)
  const raw = out.serialize()
  const sigBytes = out.signature
  if (!sigBytes) throw new Error(`${opts.label}: transaction was not signed`)
  const signature = bs58.encode(sigBytes)

  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 })
  } catch (e) {
    throw await describeSendError(conn, e, opts.label)
  }
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature])).value[0]
    if (st?.err) throw new Error(`${opts.label}: failed on-chain ${JSON.stringify(st.err)} (${signature})`)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature
    const height = await conn.getBlockHeight('confirmed')
    if (height > lastValidBlockHeight) {
      const last = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
      if (last && !last.err) return signature
      throw new Error(
        `${opts.label}: not confirmed before its blockhash expired (${signature}). It can no longer land; ` +
          're-run the script (every step is idempotent).',
      )
    }
    await sleep(opts.resendMs ?? 2_000)
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined)
  }
}

// ── SOL funding: faucet with backoff → exact manual instructions (exit 2) ────

/** the public faucet hands out at most ~1 SOL per request on devnet */
export const AIRDROP_CHUNK_LAMPORTS = LAMPORTS

export interface FundingRequest {
  label: string
  address: string
  lamports: bigint
}

export interface ManualFunding {
  primary: FundingRequest[]
  /** an equivalent alternative (e.g. fund each wallet directly instead of the funder) */
  alternative?: FundingRequest[]
}

type Exit = (code: number) => never

/** Print exactly what the user must fund (rounded up to 0.01 SOL) and exit with code 2. */
export function exitForManualFunding(funding: ManualFunding, exit: Exit = process.exit): never {
  const rows = (reqs: FundingRequest[]) =>
    reqs
      .filter((r) => r.lamports > 0n)
      .map((r) => `    ${r.label.padEnd(26)} ${r.address}   ${fmtSol(ceilToCentiSol(r.lamports))}`)
      .join('\n')
  const lines = [
    '',
    '══ MANUAL FUNDING NEEDED (devnet) ══',
    `The devnet faucet refused the airdrop. Open ${FAUCET_URL}, choose DEVNET, and send at least:`,
    '',
    rows(funding.primary),
  ]
  if (funding.alternative?.some((r) => r.lamports > 0n)) {
    lines.push('', '  or, equivalently, fund each wallet directly:', '', rows(funding.alternative))
  }
  lines.push(
    '',
    'Then re-run the same command. Every step is idempotent; nothing already done is repeated.',
    'These are throwaway DEVNET addresses. Never send mainnet SOL to them. (exit code 2)',
    '',
  )
  console.error(lines.join('\n'))
  return exit(2)
}

export interface AirdropOptions {
  label?: string
  /** attempts per ≤1 SOL chunk before giving up (default 6: waits 2+4+8+16+32 s) */
  maxAttempts?: number
  baseDelayMs?: number
  /** go straight to the manual-funding instructions without asking the faucet */
  noAirdrop?: boolean
  /** what to print on refusal, given the pubkey's current balance (default: this pubkey's shortfall) */
  fallback?: (currentBalance: bigint) => ManualFunding
  sleep?: (ms: number) => Promise<void>
  exit?: Exit
}

type AirdropConnection = Pick<Connection, 'getBalance' | 'requestAirdrop' | 'getLatestBlockhash' | 'confirmTransaction'>

/**
 * Top `pubkey` up to `targetLamports` from the devnet faucet: ≤ 1 SOL per request, exponential backoff.
 * If the faucet keeps refusing, prints the exact pubkeys + amounts to fund at faucet.solana.com and
 * exits with code 2 (never continues underfunded). Returns the final balance.
 */
export async function airdropWithBackoff(
  conn: AirdropConnection,
  pubkey: PublicKey,
  targetLamports: bigint,
  opts: AirdropOptions = {},
): Promise<bigint> {
  const label = opts.label ?? pubkey.toBase58()
  const maxAttempts = opts.maxAttempts ?? 6
  const baseDelayMs = opts.baseDelayMs ?? 2_000
  const wait = opts.sleep ?? sleep
  const exit = opts.exit ?? process.exit
  const balanceNow = async () => BigInt(await conn.getBalance(pubkey, 'confirmed'))
  const refuse = (bal: bigint): never =>
    exitForManualFunding(
      opts.fallback?.(bal) ?? {
        primary: [{ label, address: pubkey.toBase58(), lamports: targetLamports - bal }],
      },
      exit,
    )

  let balance = await balanceNow()
  if (balance >= targetLamports) return balance
  if (opts.noAirdrop) return refuse(balance)

  // bounded: every landed chunk raises the balance; a few spare rounds absorb RPC lag
  const maxChunks = Number((targetLamports - balance) / AIRDROP_CHUNK_LAMPORTS) + 4
  for (let chunkNo = 0; balance < targetLamports; chunkNo++) {
    if (chunkNo >= maxChunks) return refuse(balance)
    const want = targetLamports - balance
    const chunk = want < AIRDROP_CHUNK_LAMPORTS ? want : AIRDROP_CHUNK_LAMPORTS
    let landed = false
    for (let attempt = 1; attempt <= maxAttempts && !landed; attempt++) {
      try {
        const latest = await conn.getLatestBlockhash('confirmed')
        const signature = await conn.requestAirdrop(pubkey, Number(chunk))
        const res = await conn.confirmTransaction({ signature, ...latest }, 'confirmed')
        if (res.value.err) throw new Error(`airdrop tx failed: ${JSON.stringify(res.value.err)}`)
        landed = true
        console.log(`  faucet: ${label} +${fmtSol(chunk)} (${signature})`)
      } catch (e) {
        const delay = baseDelayMs * 2 ** (attempt - 1)
        const more = attempt < maxAttempts ? `; retrying in ${delay / 1000}s` : ''
        console.warn(
          `  faucet: ${label} +${fmtSol(chunk)} attempt ${attempt}/${maxAttempts} refused (${errMessage(e)})${more}`,
        )
        if (attempt < maxAttempts) await wait(delay)
      }
    }
    if (!landed) return refuse(await balanceNow())
    balance = await balanceNow()
  }
  return balance
}

export interface SolTarget {
  label: string
  keypair: Keypair
  lamports: bigint
}

/** per-transfer fee allowance (signature + priority fee) when the funder distributes SOL */
const TRANSFER_FEE_ALLOWANCE = 20_000n

/**
 * Bring every target up to its minimum SOL. The faucet is asked only for ONE address (the funder),
 * which then distributes with a single transfer tx: fewer faucet requests, and on refusal the user
 * funds one address. Wallets already at target are left alone.
 */
export async function fundFromFunder(
  conn: Connection,
  funder: SolTarget,
  others: SolTarget[],
  opts: { noAirdrop?: boolean } = {},
): Promise<void> {
  const balances = await getSolBalances(
    conn,
    others.map((t) => t.keypair.publicKey),
  )
  const shortfalls = others.map((t, i) => {
    const bal = balances[i] ?? 0n
    return { target: t, lamports: bal >= t.lamports ? 0n : t.lamports - bal }
  })
  const needy = shortfalls.filter((s) => s.lamports > 0n)
  const distribute = needy.reduce((sum, s) => sum + s.lamports, 0n)
  const funderTarget = funder.lamports + distribute + (needy.length ? TRANSFER_FEE_ALLOWANCE : 0n)

  await airdropWithBackoff(conn, funder.keypair.publicKey, funderTarget, {
    label: `${funder.label} (funder)`,
    noAirdrop: opts.noAirdrop,
    fallback: (bal) => ({
      primary: [
        {
          label: `${funder.label} (pays for all)`,
          address: funder.keypair.publicKey.toBase58(),
          lamports: funderTarget - bal,
        },
      ],
      alternative: [
        {
          label: funder.label,
          address: funder.keypair.publicKey.toBase58(),
          lamports: funder.lamports > bal ? funder.lamports - bal : 0n,
        },
        ...needy.map((s) => ({
          label: s.target.label,
          address: s.target.keypair.publicKey.toBase58(),
          lamports: s.lamports,
        })),
      ],
    }),
  })
  if (!needy.length) return
  const tx = new Transaction()
  for (const s of needy) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: funder.keypair.publicKey,
        toPubkey: s.target.keypair.publicKey,
        lamports: s.lamports,
      }),
    )
  }
  const sig = await sendAndConfirm(conn, tx, [funder.keypair], { label: 'distribute SOL' })
  for (const s of needy) console.log(`  SOL: ${s.target.label} +${fmtSol(s.lamports)}`)
  console.log(`  (${sig})`)
}

// ── budget table ─────────────────────────────────────────────────────────────

export interface BudgetRow {
  label: string
  address: string
  targetLamports: bigint
  balanceLamports: bigint
}

export function printSolBudget(title: string, rows: BudgetRow[], notes: string[] = []): bigint {
  const shortfall = (r: BudgetRow) => (r.balanceLamports >= r.targetLamports ? 0n : r.targetLamports - r.balanceLamports)
  const total = rows.reduce((s, r) => s + shortfall(r), 0n)
  const target = rows.reduce((s, r) => s + r.targetLamports, 0n)
  const col = (s: string, n: number) => s.padStart(n)
  console.log(`\n══ SOL BUDGET — ${title} ══`)
  console.log(`  ${'wallet'.padEnd(9)} ${'address'.padEnd(44)} ${col('target', 13)} ${col('balance', 13)} ${col('to fund', 13)}`)
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(9)} ${r.address.padEnd(44)} ${col(fmtSol(r.targetLamports), 13)} ` +
        `${col(fmtSol(r.balanceLamports), 13)} ${col(fmtSol(shortfall(r)), 13)}`,
    )
  }
  console.log(`  ${'TOTAL'.padEnd(9)} ${''.padEnd(44)} ${col(fmtSol(target), 13)} ${''.padStart(13)} ${col(fmtSol(total), 13)}`)
  for (const n of notes) console.log(`  · ${n}`)
  return total
}
