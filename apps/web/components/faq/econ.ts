import {
  DEFAULT_ECONOMY,
  entryTerms,
  expectedValueK10,
  JACKPOT_SEED_PPM,
  MICRO,
  MULT_DIVISOR_USD,
  PAYOUT_RATE_MAX_PPM,
  PAYOUT_RATE_MIN_PPM,
  PPM,
  TICKET_BLOCK_USD,
  TIERS,
} from '@scratchy/core'
import { multLabel, TIER_NAMES } from '@/lib/money'

/**
 * Every number the FAQ prints, derived from @scratchy/core (PLAN §2 / §9 defaults) — nothing hand-typed.
 * Knobs the server can change (PAYOUT_RATE) are labelled as defaults in the copy; each round's actual
 * parameters are published on /fair.
 */

const C = DEFAULT_ECONOMY

/** 5000 ppm → "0.5%", 700000 → "70%", 20 → "0.002%" */
export function pct(ppm: bigint): string {
  return `${(Number(ppm) / 10_000).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`
}
const usd = (whole: bigint) => `$${whole.toLocaleString('en-US')}`
/** "1 in 14.3" */
const oneIn = (ppm: bigint) =>
  `1 in ${(Number(PPM) / Number(ppm)).toLocaleString('en-US', { maximumFractionDigits: 1 })}`
/** tenths of e → "1.5" */
const k = (k10: bigint) => (Number(k10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })

const ticketCapUsd = (C.ticketCap / C.ticketsPer50) * TICKET_BLOCK_USD
const multCapUsd = C.multCap * MULT_DIVISOR_USD
const ev = expectedValueK10()

export const ECON = {
  minHold: usd(C.minHoldUsd),
  block: usd(TICKET_BLOCK_USD),
  ticketsPerBlock: C.ticketsPer50.toString(),
  ticketCap: C.ticketCap.toString(),
  ticketCapUsd: usd(ticketCapUsd),
  multDivisor: usd(MULT_DIVISOR_USD),
  multCap: `${C.multCap}×`,
  multCapUsd: usd(multCapUsd),
  roundMinutes: (C.roundSeconds / 60).toLocaleString('en-US'),
  roundsPerDay: Math.floor(86_400 / C.roundSeconds).toLocaleString('en-US'),
  payoutRate: pct(C.payoutRatePpm),
  payoutRateMin: pct(PAYOUT_RATE_MIN_PPM),
  payoutRateMax: pct(PAYOUT_RATE_MAX_PPM),
  jackpotShare: pct(C.jackpotSharePpm),
  ticketShare: pct(PPM - C.jackpotSharePpm),
  jackpotOdds: C.jackpotOdds.toLocaleString('en-US'),
  jackpotChance: pct(PPM / C.jackpotOdds),
  jackpotSeed: pct(JACKPOT_SEED_PPM),
  singlePrizeCap: pct(C.singlePrizeCapPpm),
  breakerX: `${(Number(C.roundBreakerPpm) / Number(PPM)).toLocaleString('en-US')}×`,
  minPoolReserve: usd(C.minPoolReserveUsd),
  minGasSol: (Number(C.minGasLamports) / 1e9).toLocaleString('en-US'),
  tradingFee: pct(C.poolTradingFeePpm),
  poolSplit: pct(C.feeSplitPoolPpm),
  opsSplit: pct(PPM - C.feeSplitPoolPpm),
  /** bar width for the pool side of the fee split (0–100) */
  poolSplitWidth: Number(C.feeSplitPoolPpm) / 10_000,
  sweepMinutes: C.sweepIntervalMin.toString(),
  anyWin: pct(PPM - TIERS[0].probPpm),
  loseChance: pct(TIERS[0].probPpm),
  /** Σ p·k — exactly 1.0 (in units of e) */
  evPerTicket: (Number(ev.num) / Number(ev.den) / 10).toFixed(1),
} as const

export interface OddsRow {
  id: number
  name: string
  chance: string
  oneIn: string
  prize: string
}

/** §2.3 odds table straight from core TIERS. */
export const ODDS_ROWS: OddsRow[] = TIERS.map((t) => ({
  id: t.id,
  name: TIER_NAMES[t.id] ?? t.label,
  chance: pct(t.probPpm),
  oneIn: t.k10 === 0n ? '—' : oneIn(t.probPpm),
  prize: t.k10 === 0n ? '—' : `${k(t.k10)}e`,
}))

export interface LadderRow {
  holding: string
  tickets: string
  mult: string
  weight: string
}

/** Illustrative holdings run through core's entryTerms (tickets, whale multiplier, share weight). */
const LADDER_USD = [50n, 250n, ticketCapUsd, 2_500n, 10_000n, multCapUsd, multCapUsd * 2n]
export const LADDER_ROWS: LadderRow[] = LADDER_USD.map((h) => {
  const t = entryTerms(h * MICRO, C)
  return {
    holding: usd(h),
    tickets: t.tickets.toString(),
    mult: multLabel(t.multMicro),
    weight: (Number(t.weightMicro) / Number(MICRO)).toLocaleString('en-US', { maximumFractionDigits: 2 }),
  }
})
