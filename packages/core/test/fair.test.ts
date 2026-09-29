import { describe, expect, it } from 'vitest'
import {
  deriveTicket,
  generateServerSeed,
  jackpotFromUniform53,
  jackpotThreshold53,
  seedCommitment,
  seedFromHex,
  seedToHex,
  ticketMessage,
  TIER_THRESHOLDS_53,
  tierFromUniform53,
  tierFromUniform53Fast,
  TWO_POW_53,
  uniform53At,
  verifySeedCommitment,
} from '../src'
import vectors from './fixtures/fair-vectors.json'

describe('§4 provably fair — cross-checked against an independent Python implementation', () => {
  it(`reproduces all ${vectors.vectors.length} vectors byte-for-byte`, () => {
    for (const v of vectors.vectors) {
      const seed = seedFromHex(v.seed)
      expect(seedCommitment(seed)).toBe(v.commitment)
      const d = deriveTicket(seed, v.wallet, v.roundId, v.idx, 50_000n)
      expect(d.digestHex).toBe(v.digest)
      expect(d.tier).toBe(v.tier)
      expect(d.jackpot).toBe(v.jackpot)
      expect(uniform53At(Buffer.from(v.digest, 'hex'), 0)).toBe(BigInt(v.x))
      expect(uniform53At(Buffer.from(v.digest, 'hex'), 8)).toBe(BigInt(v.y))
    }
  })

  it('vectors cover every tier and a jackpot hit', () => {
    expect(new Set(vectors.vectors.map((v) => v.tier))).toEqual(new Set([0, 1, 2, 3, 4, 5]))
    expect(vectors.vectors.some((v) => v.jackpot)).toBe(true)
  })

  it('message format is `${wallet}:${roundId}:${ticketIdx}`', () => {
    expect(ticketMessage('Abc', 12, 3)).toBe('Abc:12:3')
    expect(ticketMessage('Abc', 12n, 0n)).toBe('Abc:12:0')
  })

  it('commitments verify and reject tampering', () => {
    const seed = generateServerSeed()
    expect(seed.length).toBe(32)
    const hex = seedToHex(seed)
    const c = seedCommitment(seed)
    expect(verifySeedCommitment(hex, c)).toBe(true)
    const tampered = (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1)
    expect(verifySeedCommitment(tampered, c)).toBe(false)
    expect(() => seedFromHex('zz')).toThrow()
  })

  it('fresh seeds are unique', () => {
    const s = new Set(Array.from({ length: 200 }, () => seedToHex(generateServerSeed())))
    expect(s.size).toBe(200)
  })
})

describe('odds mapping boundaries', () => {
  it('fast Number thresholds equal the exact BigInt mapping at every boundary', () => {
    for (const t of TIER_THRESHOLDS_53) {
      for (const x of [t - 2, t - 1, t, t + 1]) {
        if (x < 0 || x >= 2 ** 53) continue
        expect(tierFromUniform53Fast(x)).toBe(tierFromUniform53(BigInt(x)))
      }
    }
    expect(tierFromUniform53(0n)).toBe(0)
    expect(tierFromUniform53(TWO_POW_53 - 1n)).toBe(5)
  })

  it('jackpot threshold matches the exact rule', () => {
    const t = jackpotThreshold53(50_000n)
    expect(jackpotFromUniform53(BigInt(t - 1), 50_000n)).toBe(true)
    expect(jackpotFromUniform53(BigInt(t), 50_000n)).toBe(false)
  })

  it('HMAC-derived tiers follow the odds table (χ², 60k tickets)', () => {
    const seed = seedFromHex('ab'.repeat(32))
    const counts = [0, 0, 0, 0, 0, 0]
    const N = 60_000
    for (let i = 0; i < N; i++) counts[deriveTicket(seed, 'Wallet', 1, i, 50_000n).tier]!++
    const probs = [0.7, 0.2, 0.07, 0.025, 0.004, 0.001]
    const chi2 = counts.reduce((s, c, i) => s + (c - N * probs[i]!) ** 2 / (N * probs[i]!), 0)
    expect(chi2).toBeLessThan(35.9) // χ²(5) at p = 1e-6
  })
})
