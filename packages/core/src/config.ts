import { z } from 'zod'
import { decimalToScaledExact, PPM } from './units'

/**
 * PLAN.md §9 config reference — every economy key, same names, same defaults.
 * Rates/fractions are held as exact parts-per-million bigints so no float ever enters prize math.
 */
export const SPEC_DEFAULTS = {
  PAYOUT_RATE: '0.005',
  ROUND_SECONDS: '600',
  MIN_HOLD_USD: '50',
  TICKETS_PER_50: '5',
  TICKET_CAP: '100',
  MULT_CAP: '25',
  JACKPOT_SHARE: '0.10',
  JACKPOT_ODDS: '50000',
  SINGLE_PRIZE_CAP: '0.05',
  ROUND_BREAKER: '3.0',
  MIN_POOL_RESERVE_USD: '300',
  FEE_SPLIT_POOL: '0.70',
  POOL_TRADING_FEE: '0.03',
  MIN_GAS_SOL: '0.1',
  SWEEP_INTERVAL_MIN: '5',
  PRICE_CACHE_SECONDS: '30',
} as const

export type SpecKey = keyof typeof SPEC_DEFAULTS

/**
 * §2 constants that are part of the formulas themselves (not §9 knobs):
 * - tickets = min(floor(H / 50) × 5, 100)            → the $50 ticket block
 * - mult    = clamp(H / 1000, 1, 25)                  → the $1,000 multiplier divisor
 * - "Seed J at launch with 1% of the initial pool"   → jackpot seed share (§2.4)
 */
export const TICKET_BLOCK_USD = 50n
export const MULT_DIVISOR_USD = 1000n
export const JACKPOT_SEED_PPM = 10_000n

/** §2.6: "PAYOUT_RATE is a config knob (0.3%–0.8% sane range)". Enforced for env and admin changes. */
export const PAYOUT_RATE_MIN_PPM = 3_000n
export const PAYOUT_RATE_MAX_PPM = 8_000n

export interface EconomyConfig {
  /** PAYOUT_RATE — round budget B = rate × P */
  payoutRatePpm: bigint
  /** ROUND_SECONDS — round length (600 = 10 minutes, 144/day) */
  roundSeconds: number
  /** MIN_HOLD_USD — eligibility threshold, whole USD */
  minHoldUsd: bigint
  /** TICKETS_PER_50 */
  ticketsPer50: bigint
  /** TICKET_CAP */
  ticketCap: bigint
  /** MULT_CAP */
  multCap: bigint
  /** JACKPOT_SHARE — share of B accruing to the progressive jackpot */
  jackpotSharePpm: bigint
  /** JACKPOT_ODDS — 1-in-N per scratched ticket */
  jackpotOdds: bigint
  /** SINGLE_PRIZE_CAP — any single ticket prize ≤ this share of the round's pool snapshot */
  singlePrizeCapPpm: bigint
  /** ROUND_BREAKER — realized ticket payouts above this multiple of B pause payouts (ppm of B) */
  roundBreakerPpm: bigint
  /** MIN_POOL_RESERVE_USD — whole USD, converted to PUMP at the last known price */
  minPoolReserveUsd: bigint
  /** FEE_SPLIT_POOL — share of swept fees sent to the PRIZE wallet */
  feeSplitPoolPpm: bigint
  /** POOL_TRADING_FEE — the venue pool's trading fee (display + sim + launch config) */
  poolTradingFeePpm: bigint
  /** MIN_GAS_SOL in lamports */
  minGasLamports: bigint
  /** SWEEP_INTERVAL_MIN */
  sweepIntervalMin: number
  /** PRICE_CACHE_SECONDS */
  priceCacheSeconds: number
}

const ppm = (key: SpecKey) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      try {
        return decimalToScaledExact(v, 6)
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `${key}: ${(e as Error).message}` })
        return z.NEVER
      }
    })

const posInt = (key: SpecKey) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${key} must be a positive integer`)
    .transform((v) => BigInt(v))
    .refine((v) => v > 0n, `${key} must be > 0`)

const schema = z.object({
  PAYOUT_RATE: ppm('PAYOUT_RATE').refine(
    (v) => v >= PAYOUT_RATE_MIN_PPM && v <= PAYOUT_RATE_MAX_PPM,
    'PAYOUT_RATE must be within the 0.3%–0.8% sane range (0.003–0.008)',
  ),
  ROUND_SECONDS: posInt('ROUND_SECONDS'),
  MIN_HOLD_USD: posInt('MIN_HOLD_USD'),
  TICKETS_PER_50: posInt('TICKETS_PER_50'),
  TICKET_CAP: posInt('TICKET_CAP'),
  MULT_CAP: posInt('MULT_CAP'),
  JACKPOT_SHARE: ppm('JACKPOT_SHARE').refine((v) => v >= 0n && v < PPM, 'JACKPOT_SHARE must be in [0,1)'),
  JACKPOT_ODDS: posInt('JACKPOT_ODDS'),
  SINGLE_PRIZE_CAP: ppm('SINGLE_PRIZE_CAP').refine(
    (v) => v > 0n && v <= PPM,
    'SINGLE_PRIZE_CAP must be in (0,1]',
  ),
  ROUND_BREAKER: ppm('ROUND_BREAKER').refine((v) => v > 0n, 'ROUND_BREAKER must be > 0'),
  MIN_POOL_RESERVE_USD: z
    .string()
    .trim()
    .regex(/^\d+$/, 'MIN_POOL_RESERVE_USD must be whole USD')
    .transform((v) => BigInt(v)),
  FEE_SPLIT_POOL: ppm('FEE_SPLIT_POOL').refine((v) => v > 0n && v <= PPM, 'FEE_SPLIT_POOL must be in (0,1]'),
  POOL_TRADING_FEE: ppm('POOL_TRADING_FEE').refine((v) => v >= 0n && v < PPM, 'POOL_TRADING_FEE in [0,1)'),
  MIN_GAS_SOL: z
    .string()
    .trim()
    .transform((v, ctx) => {
      try {
        return decimalToScaledExact(v, 9)
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `MIN_GAS_SOL: ${(e as Error).message}` })
        return z.NEVER
      }
    }),
  SWEEP_INTERVAL_MIN: posInt('SWEEP_INTERVAL_MIN'),
  PRICE_CACHE_SECONDS: posInt('PRICE_CACHE_SECONDS'),
})

/**
 * Build the economy config from an env-like record, falling back to the §9 defaults for any
 * missing/empty key. Throws a readable error listing every invalid key.
 */
export function parseEconomyConfig(env: Record<string, string | undefined> = {}): EconomyConfig {
  const input: Record<string, string> = {}
  for (const key of Object.keys(SPEC_DEFAULTS) as SpecKey[]) {
    const v = env[key]
    input[key] = v === undefined || v.trim() === '' ? SPEC_DEFAULTS[key] : v
  }
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n')
    throw new Error(`Invalid economy config:\n${msg}`)
  }
  const c = parsed.data
  return {
    payoutRatePpm: c.PAYOUT_RATE,
    roundSeconds: Number(c.ROUND_SECONDS),
    minHoldUsd: c.MIN_HOLD_USD,
    ticketsPer50: c.TICKETS_PER_50,
    ticketCap: c.TICKET_CAP,
    multCap: c.MULT_CAP,
    jackpotSharePpm: c.JACKPOT_SHARE,
    jackpotOdds: c.JACKPOT_ODDS,
    singlePrizeCapPpm: c.SINGLE_PRIZE_CAP,
    roundBreakerPpm: c.ROUND_BREAKER,
    minPoolReserveUsd: c.MIN_POOL_RESERVE_USD,
    feeSplitPoolPpm: c.FEE_SPLIT_POOL,
    poolTradingFeePpm: c.POOL_TRADING_FEE,
    minGasLamports: c.MIN_GAS_SOL,
    sweepIntervalMin: Number(c.SWEEP_INTERVAL_MIN),
    priceCacheSeconds: Number(c.PRICE_CACHE_SECONDS),
  }
}

/** The locked §9 defaults as a typed config. */
export const DEFAULT_ECONOMY: EconomyConfig = parseEconomyConfig({})

/** Validate a PAYOUT_RATE change coming from the admin panel (applies from the next round). */
export function validatePayoutRatePpm(ratePpm: bigint): bigint {
  if (ratePpm < PAYOUT_RATE_MIN_PPM || ratePpm > PAYOUT_RATE_MAX_PPM) {
    throw new RangeError('PAYOUT_RATE must be within 0.3%–0.8%')
  }
  return ratePpm
}
