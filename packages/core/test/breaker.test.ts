import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ECONOMY,
  parseEconomyConfig,
  gasBelowMinimum,
  hysteresisState,
  poolReserveRaw,
  slotSymbols,
  wouldTripBreaker,
  formatPump,
  formatUsdEstimate,
  truncateWallet,
} from '../src'

describe('§2.5 breaker + pauses', () => {
  it('trips only when realized payouts would EXCEED 3B', () => {
    expect(wouldTripBreaker(100n, 200n, 300n)).toBe(false)
    expect(wouldTripBreaker(100n, 201n, 300n)).toBe(true)
  })

  it('MIN_POOL_RESERVE_USD $30 converts to PUMP at the last known price (rounded up)', () => {
    // $0.0056/PUMP → 5,357.142857… PUMP → raw (6 dp) rounded up
    const r = poolReserveRaw(DEFAULT_ECONOMY, 5_600_000_000_000_000n, 6)
    expect(r).toBe(5_357_142_858n)
    expect(
      poolReserveRaw(parseEconomyConfig({ MIN_POOL_RESERVE_USD: '300' }), 5_600_000_000_000_000n, 6),
    ).toBe(53_571_428_572n)
    expect(poolReserveRaw(DEFAULT_ECONOMY, null, 6)).toBeNull()
  })

  it('hysteresis: pause below threshold, resume only at +10%', () => {
    expect(hysteresisState(false, 99n, 100n)).toBe(true)
    expect(hysteresisState(true, 105n, 100n)).toBe(true)
    expect(hysteresisState(true, 110n, 100n)).toBe(false)
    expect(hysteresisState(false, 100n, 100n)).toBe(false)
  })

  it('MIN_GAS_SOL 0.1', () => {
    expect(gasBelowMinimum(99_999_999n, DEFAULT_ECONOMY)).toBe(true)
    expect(gasBelowMinimum(100_000_000n, DEFAULT_ECONOMY)).toBe(false)
  })
})

describe('presentation helpers', () => {
  it('winners show a triple of their tier symbol; jackpots show Scratchy', () => {
    expect(slotSymbols(5, false, '00'.repeat(32))).toEqual(['crown', 'crown', 'crown'])
    expect(slotSymbols(0, true, '00'.repeat(32))).toEqual(['scratchy', 'scratchy', 'scratchy'])
  })
  it('losers never show a triple', () => {
    for (let i = 0; i < 2_000; i++) {
      const hex = (i * 2654435761).toString(16).padStart(8, '0').repeat(8)
      const [a, b, c] = slotSymbols(0, false, hex)
      expect(a === b && b === c).toBe(false)
    }
  })
  it('formats PUMP and ~$', () => {
    expect(formatPump(12_500_000_000n, 6)).toBe('12,500')
    expect(formatPump(1_234_567n, 6)).toBe('1.23')
    expect(formatUsdEstimate(12_500_000_000n, 6, 0.00336)).toBe('~$42')
    expect(formatUsdEstimate(1_000n, 6, 0.0056)).toBe('<$0.01')
    expect(formatUsdEstimate(1_000n, 6, null)).toBe('')
    expect(truncateWallet('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe('7xKX…gAsU')
  })
})
