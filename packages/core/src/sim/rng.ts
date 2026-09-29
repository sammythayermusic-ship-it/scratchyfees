/**
 * Seeded PRNG for simulations only (NOT for real outcomes — those come from fair.ts HMACs).
 * xoshiro128** seeded via splitmix32; yields exact 53-bit integers for the odds-table fast path.
 */
export class SimRng {
  private s0: number
  private s1: number
  private s2: number
  private s3: number

  constructor(seed: number) {
    let x = seed >>> 0
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0
      let z = x
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
      return (z ^ (z >>> 16)) >>> 0
    }
    this.s0 = next()
    this.s1 = next()
    this.s2 = next()
    this.s3 = next()
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0
    const t = (this.s1 << 9) >>> 0
    this.s2 ^= this.s0
    this.s3 ^= this.s1
    this.s1 ^= this.s2
    this.s0 ^= this.s3
    this.s2 ^= t
    this.s3 = rotl(this.s3, 11)
    return result
  }

  /** Exact integer in [0, 2^53): 27 high bits × 2^26 + 26 bits. */
  nextU53(): number {
    const hi = this.nextU32() >>> 5
    const lo = this.nextU32() >>> 6
    return hi * 67108864 + lo
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextU53() / 9007199254740992
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0
}
