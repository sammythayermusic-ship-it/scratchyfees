/**
 * PLAN.md §8 Phase 1 — REQUIRED economy tests (non-negotiable):
 *   1. probabilities sum to 1
 *   2. EV per ticket = 1.0e ± 1e-9
 *   3. Monte Carlo (10k rounds at 50/300/1500 tickets): mean round payout = 0.9B ± 2% and never exceeds 3B
 *      — per the user's Decision A: strict never-exceeds at 300 and 1500; at 50 the exact tail
 *        probability is 1.8e-4/round (≈83% chance of ≥1 exceedance in 10k rounds with honest RNG), so we
 *        assert the observed exceedance count is consistent with that exact probability instead.
 *   4. 30-day pool sim converges with steady inflow
 */
import { describe, expect, it } from 'vitest'
import {
  CUMULATIVE_PPM,
  DEFAULT_ECONOMY,
  expectedValueK10,
  poolReserveRaw,
  PPM,
  prizeTableRaw,
  TIERS,
} from '../src'
import {
  anyExceedanceProbability,
  exceedanceProbability,
  poissonUpperQuantile,
  simulatePool,
  simulateRounds,
  uniformWallets,
  walletsFromHoldings,
} from '../src/sim'

const cfg = DEFAULT_ECONOMY
const P = 1_000_000_000_000n // 1,000,000 PUMP (6 dp) → B = 5,000 PUMP, divisible so 0.9B is exact

describe('§8 required #1 — probabilities sum to 1', () => {
  it('odds table sums to exactly 1,000,000 ppm', () => {
    expect(TIERS.reduce((s, t) => s + t.probPpm, 0n)).toBe(PPM)
    expect(CUMULATIVE_PPM.at(-1)).toBe(PPM)
  })
  it('matches §2.3 row by row', () => {
    expect(TIERS.map((t) => [Number(t.probPpm) / 1e6, Number(t.k10) / 10])).toEqual([
      [0.7, 0],
      [0.2, 1.5],
      [0.07, 5],
      [0.025, 8],
      [0.004, 25],
      [0.001, 50],
    ])
  })
})

describe('§8 required #2 — EV per ticket = 1.0e ± 1e-9', () => {
  it('is exactly 1.0e as a rational', () => {
    const { num, den } = expectedValueK10() // tenths of e
    expect(num).toBe(10n * den)
    expect(Math.abs(Number(num) / Number(den) / 10 - 1)).toBeLessThan(1e-9)
  })
  it('holds through the real bigint prize function for any wallet mix (within rounding)', () => {
    for (const holdings of [[50], [50, 75, 99], [520, 1500, 25_000, 40_000], Array(40).fill(60)]) {
      const wallets = walletsFromHoldings(holdings, cfg)
      const res = simulateRounds({ wallets, poolRaw: P, rounds: 1, seed: 1, cfg })
      const W = res.totalWeightMicro
      // analytic EV of the whole round = Σ_w Σ_tier p·prize = ticketBudget (minus < 1 raw per ticket)
      let ev = 0
      for (const w of wallets) {
        const table = prizeTableRaw(res.budget, w.multMicro, W) // the shipped prize function
        for (const t of TIERS) ev += (Number(t.probPpm) / 1e6) * Number(table[t.id]!) * w.tickets
      }
      const tickets = wallets.reduce((s, w) => s + w.tickets, 0)
      expect(Math.abs(ev - Number(res.budget.ticketBudgetRaw))).toBeLessThanOrEqual(tickets)
    }
  })
})

describe('§8 required #3 — Monte Carlo, 10k rounds', () => {
  const ROUNDS = 10_000

  for (const n of [50, 300, 1500]) {
    it(
      `${n} tickets: mean = 0.9B ± 2%` +
        (n >= 300 ? ' and never exceeds 3B' : ' and 3B exceedances match the exact rate'),
      () => {
        const res = simulateRounds({
          wallets: uniformWallets(n),
          poolRaw: P,
          rounds: ROUNDS,
          seed: 20_260_929 + n,
          cfg,
        })
        const target = Number(res.budget.ticketBudgetRaw) // 0.9B
        expect(res.budget.ticketBudgetRaw * 10n).toBe(res.budget.budgetRaw * 9n)
        const rel = res.mean / target - 1
        expect(Math.abs(rel)).toBeLessThan(0.02)
        const threeB = res.budget.budgetRaw * 3n
        expect(res.budget.breakerLimitRaw).toBe(threeB)

        if (n >= 300) {
          expect(res.exceedances).toBe(0)
          expect(res.max <= threeB).toBe(true)
        } else {
          const p = exceedanceProbability(n)
          expect(p).toBeGreaterThan(1.7e-4)
          expect(p).toBeLessThan(1.9e-4)
          expect(anyExceedanceProbability(p, ROUNDS)).toBeGreaterThan(0.8) // why the literal assertion can't hold
          const bound = poissonUpperQuantile(p * ROUNDS, 1e-6)
          expect(res.exceedances).toBeLessThanOrEqual(bound)
        }
        console.info(
          `[MC] ${n} tickets × ${ROUNDS} rounds: mean ${(100 * (1 + rel)).toFixed(2)}% of 0.9B, ` +
            `max ${(Number(res.max) / Number(res.budget.budgetRaw)).toFixed(3)}B, >3B rounds: ${res.exceedances}` +
            (n < 300 ? ` (exact P/round = ${exceedanceProbability(n).toExponential(3)})` : ''),
        )
      },
    )
  }

  it('the exact DP and the simulator agree where exceedances are common (10 tickets)', () => {
    const p = exceedanceProbability(10) // ≈ 2.53e-2
    const res = simulateRounds({ wallets: uniformWallets(10), poolRaw: P, rounds: ROUNDS, seed: 7, cfg })
    const mean = p * ROUNDS
    const sd = Math.sqrt(ROUNDS * p * (1 - p))
    expect(Math.abs(res.exceedances - mean)).toBeLessThan(5 * sd)
  })

  it('whale-heavy mixes keep the mean at 0.9B ± 2%', () => {
    const holdings = [...Array(30).fill(75), 1_500, 8_000, 25_000, 60_000, ...Array(10).fill(600)]
    const res = simulateRounds({
      wallets: walletsFromHoldings(holdings, cfg),
      poolRaw: P,
      rounds: ROUNDS,
      seed: 99,
      cfg,
    })
    expect(Math.abs(res.mean / Number(res.budget.ticketBudgetRaw) - 1)).toBeLessThan(0.02)
  })
})

describe('§8 required #4 — 30-day pool sim converges with steady inflow', () => {
  const inflowPerDayRaw = 144n * 1_000_000_000n // 1,000 PUMP per round
  const equilibrium = 1_000_000_000n * 200n // inflow per round / 0.005

  it('expected-value dynamics converge to inflow/144/0.005 from empty and from 10× over', () => {
    for (const start of [0n, equilibrium * 10n]) {
      const res = simulatePool({
        cfg,
        days: 30,
        initialPoolRaw: start,
        inflowPerDayRaw,
        wallets: uniformWallets(300),
        stochastic: false,
        seedJackpot: false,
      })
      expect(res.equilibriumRaw).toBe(equilibrium)
      const end = Number(res.endOfDayPools.at(-1)!)
      expect(Math.abs(end / Number(equilibrium) - 1)).toBeLessThan(0.001)
      // monotone approach, never drains
      expect(res.endOfDayPools.every((p) => p > 0n)).toBe(true)
    }
  })

  it('stochastic payouts: day-30 average pool within ±5% of equilibrium', () => {
    const res = simulatePool({
      cfg,
      days: 30,
      initialPoolRaw: 0n,
      inflowPerDayRaw,
      wallets: uniformWallets(300),
      seed: 42,
      seedJackpot: false,
    })
    const lastDay = res.rounds.filter((r) => r.day === 29)
    const avg = lastDay.reduce((s, r) => s + Number(r.poolRaw), 0) / lastDay.length
    expect(Math.abs(avg / Number(equilibrium) - 1)).toBeLessThan(0.05)
  })

  it('partial scratching converges to inflow / (rate × (0.1 + 0.9 × scratchRate))', () => {
    const res = simulatePool({
      cfg,
      days: 30,
      initialPoolRaw: 0n,
      inflowPerDayRaw,
      wallets: uniformWallets(300),
      scratchRate: 0.5,
      stochastic: false,
      seedJackpot: false,
    })
    const expected = Number(equilibrium) / (0.1 + 0.9 * 0.5)
    expect(Math.abs(Number(res.equilibriumRaw) / expected - 1)).toBeLessThan(1e-6)
    expect(Math.abs(Number(res.endOfDayPools.at(-1)!) / expected - 1)).toBeLessThan(0.001)
  })

  it('an equilibrium below MIN_POOL_RESERVE skips rounds (engine behaviour) instead of paying from a sub-reserve pool', () => {
    // reserve = $300 at $0.0056 ≈ 53,571 PUMP; inflow sized so the no-reserve equilibrium would be ~41,667 PUMP
    const reserve = poolReserveRaw(cfg, 5_600_000_000_000_000n, 6)!
    const res = simulatePool({
      cfg,
      days: 10,
      initialPoolRaw: 0n,
      inflowPerDayRaw: 30_000_000_000n,
      wallets: uniformWallets(300),
      stochastic: false,
      seedJackpot: false,
      reserveRaw: reserve,
    })
    expect(res.equilibriumRaw < reserve).toBe(true)
    expect(res.skippedRounds).toBeGreaterThan(0)
    const lastDay = res.rounds.filter((r) => r.day === 9)
    expect(lastDay.some((r) => r.skipped)).toBe(true)
    // every round that actually ran started at/above the reserve
    expect(res.rounds.filter((r) => !r.skipped).every((r) => r.budgetRaw * 200n >= reserve - 200n)).toBe(true)
  })

  it('pays out ~51% of itself per day with zero inflow and never goes negative', () => {
    const res = simulatePool({
      cfg,
      days: 1,
      initialPoolRaw: P,
      inflowPerDayRaw: 0n,
      wallets: uniformWallets(1500),
      stochastic: false,
      seedJackpot: false,
    })
    const leftAfterDay = Number(res.endOfDayPools[0]!) / Number(P)
    expect(leftAfterDay).toBeGreaterThan(0.48)
    expect(leftAfterDay).toBeLessThan(0.5)
  })
})
