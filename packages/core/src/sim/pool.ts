import type { EconomyConfig } from '../config'
import { jackpotSeedRaw, prizeTableRaw, roundBudget } from '../budget'
import { totalWeightMicro } from '../eligibility'
import { hysteresisState } from '../breaker'
import { jackpotThreshold53, TIER_COUNT, tierFromUniform53Fast } from '../odds'
import type { SimWallet } from './montecarlo'
import { SimRng } from './rng'

/**
 * §2.6 sustainability — pool trajectory over many days of 144 rounds.
 * Each round: P snapshot → B = rate·P → J += 0.1·B → scratched tickets pay out → inflow arrives.
 * Unscratched prizes simply stay in the pool. Jackpot hits pay the whole pot and it re-seeds from
 * the next round's accrual. `stochastic: false` uses expected values (analytic check).
 * With `reserveRaw` set, rounds whose pool is below MIN_POOL_RESERVE (with hysteresis) are SKIPPED —
 * no budget, no jackpot accrual, no payouts — exactly as the round engine does (§2.5).
 */
export interface PoolSimOptions {
  cfg: EconomyConfig
  days: number
  initialPoolRaw: bigint
  /** raw PUMP arriving in the PRIZE wallet per day (70% share of claimed fees) */
  inflowPerDayRaw: bigint
  wallets: SimWallet[]
  /** fraction of issued tickets actually scratched (0..1) */
  scratchRate?: number
  stochastic?: boolean
  seed?: number
  roundsPerDay?: number
  seedJackpot?: boolean
  /** MIN_POOL_RESERVE in raw PUMP; rounds below it are skipped (engine behaviour) */
  reserveRaw?: bigint
  hysteresisPpm?: bigint
}

export interface PoolSimRound {
  day: number
  round: number
  poolRaw: bigint
  budgetRaw: bigint
  jackpotRaw: bigint
  paidRaw: bigint
  jackpotPaidRaw: bigint
  skipped: boolean
}

export interface PoolSimResult {
  rounds: PoolSimRound[]
  /**
   * analytic equilibrium (ignoring the reserve pause): inflow per round / (rate × f), where
   * f = jackpotShare + (1 − jackpotShare) × scratchRate is the fraction of B that leaves P each round
   */
  equilibriumRaw: bigint
  skippedRounds: number
  endOfDayPools: bigint[]
  totalPaidRaw: bigint
  totalJackpotPaidRaw: bigint
  jackpotHits: number
}

export function simulatePool(o: PoolSimOptions): PoolSimResult {
  const cfg = o.cfg
  const perDay = o.roundsPerDay ?? Math.round(86_400 / cfg.roundSeconds)
  const scratchRate = o.scratchRate ?? 1
  const stochastic = o.stochastic ?? true
  const rng = new SimRng(o.seed ?? 1)
  const W = totalWeightMicro(o.wallets.map((w) => ({ weightMicro: BigInt(w.tickets) * w.multMicro })))
  const inflowPerRound = o.inflowPerDayRaw / BigInt(perDay)
  const jpThreshold = jackpotThreshold53(cfg.jackpotOdds)
  const perTicketHitP = 1 / Number(cfg.jackpotOdds)
  const totalTickets = o.wallets.reduce((s, w) => s + w.tickets, 0)

  let pool = o.initialPoolRaw
  let jackpot = o.seedJackpot === false ? 0n : jackpotSeedRaw(o.initialPoolRaw)
  pool -= jackpot // the seed is earmarked out of the initial pool
  const rounds: PoolSimRound[] = []
  const endOfDayPools: bigint[] = []
  let totalPaid = 0n
  let totalJackpotPaid = 0n
  let jackpotHits = 0
  let skippedRounds = 0
  let paused = false

  for (let day = 0; day < o.days; day++) {
    for (let r = 0; r < perDay; r++) {
      if (o.reserveRaw !== undefined) {
        paused = hysteresisState(paused, pool, o.reserveRaw, o.hysteresisPpm ?? 100_000n)
        if (paused) {
          skippedRounds++
          pool += inflowPerRound
          rounds.push({
            day,
            round: r,
            poolRaw: pool,
            budgetRaw: 0n,
            jackpotRaw: jackpot,
            paidRaw: 0n,
            jackpotPaidRaw: 0n,
            skipped: true,
          })
          continue
        }
      }
      const budget = roundBudget(pool, cfg)
      jackpot += budget.jackpotAccrualRaw
      pool -= budget.jackpotAccrualRaw
      let paid = 0n
      let jackpotPaid = 0n
      if (W > 0n) {
        if (stochastic) {
          for (const w of o.wallets) {
            const table = prizeTableRaw(budget, w.multMicro, W)
            const counts = new Array<number>(TIER_COUNT).fill(0)
            for (let t = 0; t < w.tickets; t++) {
              if (rng.next() >= scratchRate) continue
              counts[tierFromUniform53Fast(rng.nextU53())]!++
              if (jackpot > 0n && rng.nextU53() < jpThreshold) {
                jackpotPaid += jackpot
                jackpot = 0n
                jackpotHits++
              }
            }
            for (let k = 1; k < TIER_COUNT; k++) if (counts[k]) paid += BigInt(counts[k]!) * table[k]!
          }
        } else {
          // expected values: ticket prizes pay ticketBudget × scratchRate; jackpot pays pot × P(hit)
          paid = BigInt(Math.floor(Number(budget.ticketBudgetRaw) * scratchRate))
          const pHit = 1 - Math.pow(1 - perTicketHitP, totalTickets * scratchRate)
          jackpotPaid = BigInt(Math.floor(Number(jackpot) * pHit))
          jackpot -= jackpotPaid
        }
      }
      pool = pool - paid + inflowPerRound
      totalPaid += paid
      totalJackpotPaid += jackpotPaid
      rounds.push({
        day,
        round: r,
        poolRaw: pool,
        budgetRaw: budget.budgetRaw,
        jackpotRaw: jackpot,
        paidRaw: paid,
        jackpotPaidRaw: jackpotPaid,
        skipped: false,
      })
    }
    endOfDayPools.push(pool)
  }
  const js = Number(cfg.jackpotSharePpm) / 1e6
  const leaveFraction = js + (1 - js) * scratchRate
  return {
    rounds,
    skippedRounds,
    equilibriumRaw:
      scratchRate === 1
        ? (inflowPerRound * 1_000_000n) / cfg.payoutRatePpm
        : BigInt(Math.round((Number(inflowPerRound) * 1e6) / (Number(cfg.payoutRatePpm) * leaveFraction))),
    endOfDayPools,
    totalPaidRaw: totalPaid,
    totalJackpotPaidRaw: totalJackpotPaid,
    jackpotHits,
  }
}
