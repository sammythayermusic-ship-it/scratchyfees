import { describe, expect, it } from 'vitest'
import {
  CUMULATIVE_PPM,
  DEFAULT_ECONOMY,
  deriveTicket,
  entryTerms,
  expectedValueK10,
  PPM,
  roundBudget,
  seedCommitment,
  seedFromHex,
  tierPrizeRaw,
} from '../src'

describe('core smoke', () => {
  it('loads §9 defaults', () => {
    expect(DEFAULT_ECONOMY.payoutRatePpm).toBe(5_000n)
    expect(DEFAULT_ECONOMY.roundSeconds).toBe(600)
    expect(DEFAULT_ECONOMY.jackpotOdds).toBe(50_000n)
  })
  it('odds sum to 1 and EV = 1.0e', () => {
    expect(CUMULATIVE_PPM.at(-1)).toBe(PPM)
    const ev = expectedValueK10()
    expect(ev.num).toBe(10n * ev.den)
  })
  it('computes a round end to end', () => {
    const t = entryTerms(520_000_000n, DEFAULT_ECONOMY) // $520
    expect(t.tickets).toBe(50n)
    expect(t.multMicro).toBe(1_000_000n)
    const b = roundBudget(1_000_000_000_000n, DEFAULT_ECONOMY)
    expect(b.budgetRaw).toBe(5_000_000_000n)
    expect(b.jackpotAccrualRaw + b.ticketBudgetRaw).toBe(b.budgetRaw)
    expect(tierPrizeRaw(500n, b, t.multMicro, t.weightMicro)).toBe(b.ticketBudgetRaw) // 50e with W=50 → 50·0.9B/50
  })
  it('derives a deterministic ticket', () => {
    const seed = seedFromHex('00'.repeat(32))
    expect(seedCommitment(seed)).toBe('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925')
    const a = deriveTicket(seed, 'Wallet111', 1, 0, 50_000n)
    const b = deriveTicket(seed, 'Wallet111', 1, 0, 50_000n)
    expect(a).toEqual(b)
  })
})
