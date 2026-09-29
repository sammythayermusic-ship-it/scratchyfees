import { parseEconomyConfig, type EconomyConfig } from '@scratchy/core'
import { z } from 'zod'

/**
 * Runtime configuration. Every variable is documented in /.env.example.
 * Economy keys (PLAN.md §9) are parsed by @scratchy/core; everything else lives here.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
    )

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= min, `must be an integer ≥ ${min}`)

const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : v.trim()))

const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

export const REAL_PUMP_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: str('0.0.0.0'),
  PORT: int(4000, 1),
  LOG_LEVEL: str('info'),
  /** Identifies this deployment in on-chain memos so a DB reset can never collide with old txs. */
  DEPLOY_ID: str('local'),
  DATABASE_URL: str('postgres://scratchy:scratchy@127.0.0.1:5433/scratchy'),

  // §9 site identity
  DOMAIN: str('scratchyfees.fun'),
  API_ORIGIN: str('https://api.scratchyfees.fun'),
  X_HANDLE: str('ScratchyFees'),

  // HTTP edge
  CORS_ORIGINS: list,
  TRUST_CLOUDFLARE: bool(false),
  ADMIN_TOKEN: optStr,

  // Chain
  CHAIN_MODE: z.enum(['memory', 'solana']).default('memory'),
  SOLANA_CLUSTER: z.enum(['devnet', 'mainnet-beta', 'localnet']).default('devnet'),
  ALLOW_MAINNET: str('no'),
  RPC_URL: str('https://api.devnet.solana.com'),
  RPC_WS_URL: optStr,
  PUMP_MINT: str(REAL_PUMP_MINT),
  PUMP_PRICE_MINT: str(REAL_PUMP_MINT),
  SCRATCHY_MINT: optStr,
  PRIZE_WALLET_KEY: optStr,
  PRIZE_WALLET_ADDRESS: optStr,
  CREATOR_WALLET_KEY: optStr,
  CREATOR_WALLET_ADDRESS: optStr,
  OPS_WALLET_ADDRESS: optStr,
  EXCLUDED_WALLETS: list,
  PRIORITY_FEE_MICROLAMPORTS: int(20_000),
  PRIORITY_FEE_MAX_MICROLAMPORTS: int(500_000),
  PAYOUT_CONCURRENCY: int(4, 1),
  ATA_RECREATE_LIMIT: int(0),
  HOLDINGS_CACHE_SECONDS: int(10),
  /** CREATOR (fee-claim wallet) SOL floor — alert only */
  MIN_CREATOR_GAS_SOL: str('0.05'),

  // Venue + sweeper
  VENUE: z.enum(['memory', 'damm-v2']).default('memory'),
  VENUE_POOL_ADDRESS: optStr,
  VENUE_POSITION_ADDRESS: optStr,
  SWAP: z.enum(['none', 'jupiter', 'damm-v2', 'memory']).default('none'),
  /** pool used by SWAP=damm-v2 (devnet: the BothToken test pool); defaults to VENUE_POOL_ADDRESS */
  SWAP_POOL_ADDRESS: optStr,
  SWEEP_MAX_SLIPPAGE_BPS: int(300),
  SWEEPER_ENABLED: bool(true),

  // Prices
  PRICE_SOURCE: z.enum(['live', 'mock']).default('mock'),
  JUPITER_API_BASE: str('https://api.jup.ag'),
  JUPITER_API_KEY: optStr,
  DEXSCREENER_API_BASE: str('https://api.dexscreener.com'),
  MOCK_PUMP_USD: str('0.0056'),

  // Alerts
  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_CHAT_ID: optStr,
  TELEGRAM_DIGEST_SECONDS: int(5, 1),

  // Engine + abuse controls
  ENGINE_ENABLED: bool(true),
  RESERVE_HYSTERESIS: str('0.10'),
  REQUIRE_HOLD_ONE_ROUND: bool(false),
  MAX_WALLETS_PER_IP_PER_ROUND: int(3, 1),
  SESSION_LOCK_SECONDS: int(45, 5),
  RATE_LIMIT_ENTER_PER_MIN: int(20, 1),
  RATE_LIMIT_SCRATCH_PER_MIN: int(240, 1),
  RATE_LIMIT_WALLET_PER_MIN: int(300, 1),
  /** Devnet-only rehearsal helper (forces a jackpot by grinding seeds). Refused on any other cluster. */
  DEV_FORCE_JACKPOT: bool(false),
  /** the rehearsal wallet whose ticket 0 is ground into a jackpot hit (devnet only) */
  DEV_FORCE_JACKPOT_WALLET: optStr,
  /** with DEV_FORCE_JACKPOT: grind only this round id's seed (0 = every round) — devnet only */
  DEV_FORCE_JACKPOT_ROUND: int(0, 0),
  /** rehearsal: this round id runs with a 1-ppm breaker so any win trips it (Decision E drill) — devnet only */
  DEV_FORCE_BREAKER_ROUND: int(0, 0),
})

export type RuntimeEnv = z.infer<typeof schema>

export interface AppConfig {
  env: RuntimeEnv
  economy: EconomyConfig
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment:\n${msg}`)
  }
  const env = parsed.data
  const economy = parseEconomyConfig(source)

  // Mainnet interlock: nothing touches mainnet unless explicitly armed (Phase 6 checklist).
  if (env.SOLANA_CLUSTER === 'mainnet-beta' && env.ALLOW_MAINNET !== 'yes') {
    throw new Error(
      'SOLANA_CLUSTER=mainnet-beta refused: set ALLOW_MAINNET=yes only as part of the launch checklist',
    )
  }
  if (
    env.SOLANA_CLUSTER === 'mainnet-beta' &&
    (env.PUMP_MINT !== REAL_PUMP_MINT || env.PUMP_PRICE_MINT !== REAL_PUMP_MINT)
  ) {
    throw new Error('on mainnet-beta PUMP_MINT and PUMP_PRICE_MINT must both be the real PUMP mint')
  }
  if (env.SOLANA_CLUSTER === 'mainnet-beta' && env.CHAIN_MODE !== 'solana') {
    throw new Error('mainnet-beta requires CHAIN_MODE=solana')
  }
  if (env.SOLANA_CLUSTER === 'mainnet-beta' && env.PRICE_SOURCE !== 'live') {
    throw new Error('mainnet-beta requires PRICE_SOURCE=live (mock prices would size eligibility wrongly)')
  }
  if (env.NODE_ENV === 'production' && env.CHAIN_MODE !== 'solana') {
    throw new Error('NODE_ENV=production requires CHAIN_MODE=solana (memory mode is for local dev and tests)')
  }
  if ((env.DEV_FORCE_JACKPOT || env.DEV_FORCE_BREAKER_ROUND > 0) && env.SOLANA_CLUSTER === 'mainnet-beta') {
    throw new Error('DEV_FORCE_JACKPOT / DEV_FORCE_BREAKER_ROUND are devnet/localnet-only')
  }
  if (env.NODE_ENV === 'production' && (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32)) {
    throw new Error('ADMIN_TOKEN must be set (≥ 32 chars) in production')
  }
  if (env.CORS_ORIGINS.length === 0) {
    env.CORS_ORIGINS =
      env.NODE_ENV === 'production'
        ? [`https://${env.DOMAIN}`]
        : ['http://localhost:3000', 'http://127.0.0.1:3000']
  }
  return { env, economy }
}
