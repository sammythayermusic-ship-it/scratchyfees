import { describe, expect, it } from 'vitest'
import {
  budgetFromParams,
  DEFAULT_ECONOMY,
  deriveTicket,
  jackpotRecurrence,
  liabilitiesCovered,
  MICRO,
  prizeWithinCap,
  recomputeTicket,
  reconcileBalances,
  roundBudget,
  roundParamsFromConfig,
  seedCommitment,
  seedFromHex,
  seedMatchesCommitment,
  sweepSplitExact,
  tierPrizeRaw,
  TIERS,
} from '../src'

describe('recompute / verification', () => {
  const seedHex = 'cd'.repeat(32)
  const params = roundParamsFromConfig(42, 777_000_000_000n, 350n * MICRO, DEFAULT_ECONOMY)

  it('budgetFromParams equals roundBudget for the same inputs', () => {
    for (const P of [0n, 1n, 999n, 123_456_789_000n, 10n ** 18n]) {
      const p = roundParamsFromConfig(1, P, MICRO, DEFAULT_ECONOMY)
      expect(budgetFromParams(p)).toEqual(roundBudget(P, DEFAULT_ECONOMY))
    }
  })

  it('recomputeTicket matches a direct derivation + prize', () => {
    for (let idx = 0; idx < 50; idx++) {
      const r = recomputeTicket(seedHex, 'Wal', idx, 2n * MICRO, params)
      const d = deriveTicket(seedFromHex(seedHex), 'Wal', 42, idx, 50_000n)
      expect(r.tier).toBe(d.tier)
      expect(r.prizeRaw).toBe(
        tierPrizeRaw(TIERS[d.tier]!.k10, budgetFromParams(params), 2n * MICRO, params.totalWeightMicro),
      )
    }
  })

  it('seed reveal must match the published commitment', () => {
    expect(seedMatchesCommitment(seedHex, seedCommitment(seedFromHex(seedHex)))).toBe(true)
    expect(seedMatchesCommitment(seedHex, '00'.repeat(32))).toBe(false)
    const c = seedCommitment(seedFromHex(seedHex))
    expect(seedMatchesCommitment(seedHex, ` ${c.toUpperCase()}\n`)).toBe(true)
  })
})

describe('accounting invariants', () => {
  it('liabilities covered', () => {
    expect(liabilitiesCovered(100n, 60n, 40n)).toBeNull()
    expect(liabilitiesCovered(99n, 60n, 40n)).toMatch(/wallet/)
  })
  it('jackpot recurrence', () => {
    expect(jackpotRecurrence(100n, 10n, 0n, 110n)).toBeNull()
    expect(jackpotRecurrence(100n, 10n, 110n, 0n)).toBeNull()
    expect(jackpotRecurrence(100n, 10n, 0n, 111n)).toMatch(/≠/)
  })
  it('prize cap', () => {
    expect(prizeWithinCap(5n, 5n)).toBeNull()
    expect(prizeWithinCap(6n, 5n)).toMatch(/cap/)
  })
  it('sweep split', () => {
    expect(sweepSplitExact(10n, 7n, 3n, DEFAULT_ECONOMY)).toBeNull()
    expect(sweepSplitExact(10n, 6n, 4n, DEFAULT_ECONOMY)).toMatch(/share/)
    expect(sweepSplitExact(10n, 7n, 2n, DEFAULT_ECONOMY)).toMatch(/≠/)
  })
})

describe('ledger vs chain reconciliation', () => {
  it('inflows are booked, outflows are emergencies', () => {
    expect(reconcileBalances(100n, 100n)).toEqual({ status: 'ok', deltaRaw: 0n })
    expect(reconcileBalances(150n, 100n)).toEqual({ status: 'inflow', deltaRaw: 50n })
    expect(reconcileBalances(90n, 100n)).toEqual({ status: 'outflow', deltaRaw: 10n })
  })
})
