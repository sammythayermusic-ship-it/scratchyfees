import type { EconomyConfig } from '../config'
import { prizeTableRaw, roundBudget, type RoundBudget } from '../budget'
import { entryTerms, totalWeightMicro } from '../eligibility'
import { jackpotThreshold53, TIER_COUNT, tierFromUniform53Fast } from '../odds'
import { MICRO } from '../units'
import { SimRng } from './rng'

/** A wallet in a simulated round: its ticket count and multiplier (micro-units). */
export interface SimWallet {
  tickets: number
  multMicro: bigint
}

/** Wallets for "N tickets in play", all mult 1 (5 tickets each, like $50–$99 holders). */
export function uniformWallets(totalTickets: number, perWallet = 5): SimWallet[] {
  const out: SimWallet[] = []
  let left = totalTickets
  while (left > 0) {
    const t = Math.min(perWallet, left)
    out.push({ tickets: t, multMicro: MICRO })
    left -= t
  }
  return out
}

/** Wallets from USD holdings (e.g. a mix of shrimp and whales). */
export function walletsFromHoldings(holdingsUsd: number[], cfg: EconomyConfig): SimWallet[] {
  return holdingsUsd
    .map((h) => entryTerms(BigInt(Math.round(h * 1e6)), cfg))
    .filter((t) => t.eligible)
    .map((t) => ({ tickets: Number(t.tickets), multMicro: t.multMicro }))
}

export interface MonteCarloResult {
  budget: RoundBudget
  totalWeightMicro: bigint
  /** realized ticket payouts per round (raw), all tickets scratched */
  payouts: bigint[]
  /** jackpot rolls hit per round */
  jackpotHits: number[]
  mean: number
  max: bigint
  /** rounds whose payouts exceed ROUND_BREAKER × B */
  exceedances: number
}

/**
 * Simulate `rounds` independent rounds with the same pool/entrant set. Uses the exact odds mapping
 * (fast integer path) and the real bigint prize function, so what is tested is what ships.
 */
export function simulateRounds(opts: {
  wallets: SimWallet[]
  poolRaw: bigint
  rounds: number
  seed: number
  cfg: EconomyConfig
}): MonteCarloResult {
  const { wallets, poolRaw, rounds, cfg } = opts
  const rng = new SimRng(opts.seed)
  const budget = roundBudget(poolRaw, cfg)
  const W = totalWeightMicro(wallets.map((w) => ({ weightMicro: BigInt(w.tickets) * w.multMicro })))
  const tables = wallets.map((w) => prizeTableRaw(budget, w.multMicro, W))
  const jpThreshold = jackpotThreshold53(cfg.jackpotOdds)
  const payouts: bigint[] = new Array(rounds)
  const jackpotHits: number[] = new Array(rounds)
  const counts = new Int32Array(TIER_COUNT)
  let sum = 0n
  let max = 0n
  let exceedances = 0
  for (let r = 0; r < rounds; r++) {
    let roundTotal = 0n
    let hits = 0
    for (let wi = 0; wi < wallets.length; wi++) {
      counts.fill(0)
      const n = wallets[wi]!.tickets
      for (let t = 0; t < n; t++) {
        counts[tierFromUniform53Fast(rng.nextU53())]!++
        if (rng.nextU53() < jpThreshold) hits++
      }
      const table = tables[wi]!
      for (let k = 1; k < TIER_COUNT; k++) if (counts[k]) roundTotal += BigInt(counts[k]!) * table[k]!
    }
    payouts[r] = roundTotal
    jackpotHits[r] = hits
    sum += roundTotal
    if (roundTotal > max) max = roundTotal
    if (roundTotal > budget.breakerLimitRaw) exceedances++
  }
  return {
    budget,
    totalWeightMicro: W,
    payouts,
    jackpotHits,
    mean: Number(sum) / rounds,
    max,
    exceedances,
  }
}
