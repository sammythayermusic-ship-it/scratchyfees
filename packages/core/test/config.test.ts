import { describe, expect, it } from 'vitest'
import { DEFAULT_ECONOMY, parseEconomyConfig, SPEC_DEFAULTS, validatePayoutRatePpm } from '../src'

describe('§9 config reference', () => {
  it('defaults are exactly the spec values', () => {
    expect(SPEC_DEFAULTS).toMatchObject({
      PAYOUT_RATE: '0.005',
      ROUND_SECONDS: '600',
      MIN_HOLD_USD: '50',
      TICKETS_PER_50: '5',
      TICKET_CAP: '100',
      MULT_CAP: '25',
      JACKPOT_SHARE: '0.10',
      JACKPOT_ODDS: '50000',
      SINGLE_PRIZE_CAP: '0.05',
      ROUND_BREAKER: '3.0',
      MIN_POOL_RESERVE_USD: '30',
      FEE_SPLIT_POOL: '0.70',
      POOL_TRADING_FEE: '0.03',
      MIN_GAS_SOL: '0.1',
      SWEEP_INTERVAL_MIN: '5',
      PRICE_CACHE_SECONDS: '30',
    })
    expect(DEFAULT_ECONOMY).toMatchObject({
      payoutRatePpm: 5_000n,
      roundSeconds: 600,
      jackpotSharePpm: 100_000n,
      singlePrizeCapPpm: 50_000n,
      roundBreakerPpm: 3_000_000n,
      feeSplitPoolPpm: 700_000n,
      poolTradingFeePpm: 30_000n,
      minGasLamports: 100_000_000n,
      minPoolReserveUsd: 30n,
    })
  })

  it('accepts overrides and blank values fall back to defaults', () => {
    const c = parseEconomyConfig({ PAYOUT_RATE: '0.003', ROUND_SECONDS: '20', MULT_CAP: '' })
    expect(c.payoutRatePpm).toBe(3_000n)
    expect(c.roundSeconds).toBe(20)
    expect(c.multCap).toBe(25n)
  })

  it('rejects PAYOUT_RATE outside 0.3%–0.8% and sub-ppm precision', () => {
    expect(() => parseEconomyConfig({ PAYOUT_RATE: '0.0081' })).toThrow(/0.3%–0.8%/)
    expect(() => parseEconomyConfig({ PAYOUT_RATE: '0.0029' })).toThrow(/0.3%–0.8%/)
    expect(() => parseEconomyConfig({ PAYOUT_RATE: '0.0050001' })).toThrow(/precision/)
    expect(() => validatePayoutRatePpm(9_000n)).toThrow()
    expect(validatePayoutRatePpm(8_000n)).toBe(8_000n)
  })

  it('rejects nonsense', () => {
    expect(() => parseEconomyConfig({ TICKET_CAP: '-5' })).toThrow()
    expect(() => parseEconomyConfig({ JACKPOT_SHARE: '1.5' })).toThrow()
    expect(() => parseEconomyConfig({ ROUND_SECONDS: 'ten' })).toThrow()
    expect(() => parseEconomyConfig({ ROUND_SECONDS: '172801' })).toThrow()
    expect(() => parseEconomyConfig({ MIN_GAS_SOL: '-0.1' })).toThrow(/MIN_GAS_SOL/)
    expect(() => parseEconomyConfig({ MIN_GAS_SOL: '0' })).toThrow(/MIN_GAS_SOL/)
    expect(() => parseEconomyConfig({ MIN_POOL_RESERVE_USD: '0' })).toThrow(/MIN_POOL_RESERVE_USD/)
  })
})
