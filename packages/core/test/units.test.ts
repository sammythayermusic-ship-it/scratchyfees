import { describe, expect, it } from 'vitest'
import { decimalToScaled, decimalToScaledExact, mulDivCeil, mulDivFloor, scaledToDecimal } from '../src'

describe('exact decimal parsing', () => {
  it.each([
    ['0.005', 6, 5_000n],
    ['5.6652589e-3', 18, 5_665_258_900_000_000n],
    [0.0056652589, 18, 5_665_258_900_000_000n],
    ['1e3', 0, 1_000n],
    ['.5', 1, 5n],
    ['  2.50 ', 2, 250n],
    ['-0.1', 3, -100n],
    ['0.123456789', 6, 123_456n],
  ])('%s @1e%s → %s', (v, s, out) => {
    expect(decimalToScaled(v, s)).toBe(out)
  })

  it('exact mode refuses to lose precision', () => {
    expect(() => decimalToScaledExact('0.1234567', 6)).toThrow()
    expect(decimalToScaledExact('0.123456', 6)).toBe(123_456n)
  })

  it('refuses absurd exponents/lengths from external strings (no CPU hang)', () => {
    const t = Date.now()
    expect(() => decimalToScaled('1e-30000000', 18)).toThrow(/out of range/)
    expect(() => decimalToScaled('9'.repeat(1000), 0)).toThrow(/out of range/)
    expect(Date.now() - t).toBeLessThan(50)
  })

  it('rejects garbage', () => {
    for (const bad of ['', 'abc', '1.2.3', '--1', NaN, Infinity])
      expect(() => decimalToScaled(bad as never, 6)).toThrow()
  })

  it('round-trips and rounds correctly', () => {
    expect(scaledToDecimal(12_500_000_000n, 6)).toBe('12500')
    expect(scaledToDecimal(1_234_567n, 6)).toBe('1.234567')
    expect(scaledToDecimal(-5n, 3)).toBe('-0.005')
    expect(mulDivFloor(7n, 3n, 2n)).toBe(10n)
    expect(mulDivCeil(7n, 3n, 2n)).toBe(11n)
  })
})
