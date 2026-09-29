import { TIERS } from '../odds'

/**
 * Exact distribution of one round's ticket payouts for n tickets with equal multipliers, by dynamic
 * programming over the odds table (prizes in tenths of e). Returns P(round payouts > breaker × B).
 *
 * With equal multipliers e·mult is the same for every ticket and W = n, so
 *   breaker × B  =  breaker × (10/9)·n·e      →   in tenths of e:  breaker × 100·n / 9
 * (ticket share = 1 − JACKPOT_SHARE; both are passed in as ppm so the math is not hard-coded).
 */
export function exceedanceProbability(n: number, breakerPpm = 3_000_000, ticketSharePpm = 900_000): number {
  // threshold (tenths of e) = breaker × 10 × n / ticketShare, in exact integer arithmetic;
  // sums ≤ cap are "not exceeded" (strictly greater trips the breaker)
  const cap = Math.floor((breakerPpm * 10 * n) / ticketSharePpm)
  if (!Number.isSafeInteger(breakerPpm * 10 * n)) throw new RangeError('n too large')
  let dist = new Float64Array(cap + 1)
  dist[0] = 1
  let over = 0
  const vals = TIERS.map((t) => Number(t.k10))
  const probs = TIERS.map((t) => Number(t.probPpm) / 1e6)
  for (let i = 0; i < n; i++) {
    const next = new Float64Array(cap + 1)
    for (let s = 0; s <= cap; s++) {
      const m = dist[s]!
      if (m === 0) continue
      for (let k = 0; k < vals.length; k++) {
        const t = s + vals[k]!
        if (t > cap) over += m * probs[k]!
        else next[t] = next[t]! + m * probs[k]!
      }
    }
    dist = next
  }
  return over
}

/** P(at least one exceedance in `rounds` independent rounds). */
export function anyExceedanceProbability(p: number, rounds: number): number {
  return 1 - Math.pow(1 - p, rounds)
}

/** Smallest k with P(Poisson(λ) > k) < tail — used for an honest upper bound on observed counts. */
export function poissonUpperQuantile(lambda: number, tail: number): number {
  let k = 0
  let pmf = Math.exp(-lambda)
  let cdf = pmf
  while (1 - cdf >= tail) {
    k++
    pmf *= lambda / k
    cdf += pmf
    if (k > 10_000) break
  }
  return k
}
