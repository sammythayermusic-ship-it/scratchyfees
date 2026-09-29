import { PPM, TWO_POW_53 } from './units'

/**
 * PLAN.md §2.3 — per-ticket odds table. LOCKED.
 * Prizes are in units of e (the per-weighted-ticket expected value), stored as tenths of e (k10)
 * so 1.5e is an exact integer. Probabilities are exact parts-per-million.
 *
 *   70.0% → 0      loser
 *   20.0% → 1.5e   small hit
 *    7.0% → 5e     nice hit
 *    2.5% → 8e     big hit
 *    0.4% → 25e    HUGE
 *    0.1% → 50e    TIER-MAX
 */
export const TIERS = [
  { id: 0, key: 'loser', probPpm: 700_000n, k10: 0n, label: 'No win', feel: 'loser' },
  { id: 1, key: 'small', probPpm: 200_000n, k10: 15n, label: '1.5×', feel: 'small hit' },
  { id: 2, key: 'nice', probPpm: 70_000n, k10: 50n, label: '5×', feel: 'nice hit' },
  { id: 3, key: 'big', probPpm: 25_000n, k10: 80n, label: '8×', feel: 'big hit' },
  { id: 4, key: 'huge', probPpm: 4_000n, k10: 250n, label: '25×', feel: 'HUGE' },
  { id: 5, key: 'tiermax', probPpm: 1_000n, k10: 500n, label: '50×', feel: 'TIER-MAX' },
] as const

export type Tier = (typeof TIERS)[number]
export type TierId = Tier['id']
export type TierKey = Tier['key']

export const TIER_COUNT = TIERS.length

/** Cumulative probability (ppm) upper bound of each tier: [700000, 900000, 970000, 995000, 999000, 1000000]. */
export const CUMULATIVE_PPM: readonly bigint[] = TIERS.reduce<bigint[]>((acc, t) => {
  acc.push((acc.at(-1) ?? 0n) + t.probPpm)
  return acc
}, [])

if (CUMULATIVE_PPM.at(-1) !== PPM) {
  throw new Error('odds table probabilities must sum to exactly 1,000,000 ppm')
}

export function tierById(id: number): Tier {
  const t = TIERS[id]
  if (!t) throw new RangeError(`unknown tier id ${id}`)
  return t
}

export function tierByKey(key: string): Tier {
  const t = TIERS.find((x) => x.key === key)
  if (!t) throw new RangeError(`unknown tier key ${key}`)
  return t
}

/**
 * Map a uniform 53-bit integer x ∈ [0, 2^53) — i.e. u = x / 2^53 ∈ [0, 1) — through the odds table.
 * Tier = the first i with u < cumulative_i, evaluated exactly as x·1e6 < cumulative_i·2^53 so there is
 * no floating-point boundary error (0.7 + 0.2 ≠ 0.9 in IEEE-754).
 */
export function tierFromUniform53(x: bigint): TierId {
  if (x < 0n || x >= TWO_POW_53) throw new RangeError('uniform53 out of range')
  const lhs = x * PPM
  for (let i = 0; i < CUMULATIVE_PPM.length; i++) {
    if (lhs < CUMULATIVE_PPM[i]! * TWO_POW_53) return TIERS[i]!.id
  }
  // unreachable: the last cumulative bound is exactly 1.0
  throw new Error('tierFromUniform53: fell through the odds table')
}

/** §2.4 — jackpot roll: hit iff u < 1/odds, evaluated exactly as y·odds < 2^53. */
export function jackpotFromUniform53(y: bigint, odds: bigint): boolean {
  if (y < 0n || y >= TWO_POW_53) throw new RangeError('uniform53 out of range')
  if (odds <= 0n) throw new RangeError('jackpot odds must be > 0')
  return y * odds < TWO_POW_53
}

/** Expected value of one ticket in tenths of e: Σ p·k10 / 1e6. Equals exactly 10 (i.e. 1.0e). */
export function expectedValueK10(): { num: bigint; den: bigint } {
  const num = TIERS.reduce((s, t) => s + t.probPpm * t.k10, 0n)
  return { num, den: PPM }
}
