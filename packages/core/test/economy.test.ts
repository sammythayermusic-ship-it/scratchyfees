import { describe, expect, it } from 'vitest'
import {
  accrueJackpot,
  DEFAULT_ECONOMY,
  entryTerms,
  holdingsTier,
  holdMoreNudge,
  perWeightedTicketEv,
  shouldVoidOnRecheckBalances,
  holdingsUsdMicro,
  jackpotSeedRaw,
  MICRO,
  multMicroFor,
  parseEconomyConfig,
  poolSnapshot,
  prizeForTierRaw,
  roundBudget,
  shouldVoidOnRecheck,
  splitFees,
  ticketsFor,
  tierPrizeRaw,
} from '../src'

const cfg = DEFAULT_ECONOMY
const usd = (h: number) => BigInt(Math.round(h * 1e6))

describe('§2.1 eligibility & tickets', () => {
  it.each([
    [49.99, 0n],
    [50, 5n],
    [99.99, 5n],
    [100, 10n],
    [520, 50n],
    [999.99, 95n],
    [1_000, 100n],
    [1_000_000, 100n],
  ])('H=$%s → %s tickets', (h, t) => {
    expect(ticketsFor(usd(h), cfg)).toBe(t)
  })

  it.each([
    [50, 1],
    [999, 1],
    [1_000, 1],
    [1_500, 1.5],
    [12_345.678, 12.345678],
    [25_000, 25],
    [40_000, 25],
  ])('H=$%s → mult %s', (h, m) => {
    expect(Number(multMicroFor(usd(h), cfg)) / 1e6).toBeCloseTo(m, 6)
  })

  it('EV is linear in dollars from $50 to $25,000 (w = H/10 at every $50 step) and flat above', () => {
    for (let h = 50; h <= 25_000; h += 50) {
      expect(entryTerms(usd(h), cfg).weightMicro).toBe(usd(h) / 10n)
    }
    expect(entryTerms(usd(30_000), cfg).weightMicro).toBe(2_500n * MICRO)
  })

  it('splitting a bag across wallets gains nothing on ticket prizes (anti-sybil)', () => {
    const one = entryTerms(usd(5_000), cfg).weightMicro
    const five = 5n * entryTerms(usd(1_000), cfg).weightMicro
    const hundred = 100n * entryTerms(usd(50), cfg).weightMicro
    expect(one).toBe(five)
    expect(one).toBe(hundred)
  })

  it('computes H from a raw balance and a 1e18-scaled price', () => {
    // 1,000,000 tokens (6 dp) at $0.00052 → $520
    expect(holdingsUsdMicro(1_000_000_000_000n, 6, 520_000_000_000_000n)).toBe(usd(520))
  })
})

describe('§2.2 budget and §2.4 jackpot', () => {
  it('B = 0.5% of P, split 90/10 exactly', () => {
    const b = roundBudget(1_234_567_891_011n, cfg)
    expect(b.budgetRaw).toBe((1_234_567_891_011n * 5_000n) / 1_000_000n)
    expect(b.jackpotAccrualRaw).toBe(b.budgetRaw / 10n)
    expect(b.ticketBudgetRaw + b.jackpotAccrualRaw).toBe(b.budgetRaw)
    expect(b.breakerLimitRaw).toBe(b.budgetRaw * 3n)
    expect(b.singlePrizeCapRaw).toBe(1_234_567_891_011n / 20n)
  })

  it('P = wallet − J − outstanding, never negative', () => {
    expect(poolSnapshot({ walletBalanceRaw: 100n, jackpotRaw: 30n, outstandingRaw: 20n })).toBe(50n)
    expect(poolSnapshot({ walletBalanceRaw: 10n, jackpotRaw: 30n, outstandingRaw: 20n })).toBe(0n)
  })

  it('jackpot seeds at 1% of the initial pool and accrues 0.1·B each round', () => {
    expect(jackpotSeedRaw(1_000_000n)).toBe(10_000n)
    const b = roundBudget(1_000_000_000n, cfg)
    expect(accrueJackpot(10n, b)).toBe(10n + b.jackpotAccrualRaw)
  })

  it('70/30 fee split sums exactly', () => {
    for (const total of [0n, 1n, 7n, 10n, 999_999_999n, 123_456_789_012_345n]) {
      const s = splitFees(total, cfg)
      expect(s.toPrizeRaw + s.toOpsRaw).toBe(total)
      expect(s.toPrizeRaw).toBe((total * 7n) / 10n)
    }
  })
})

describe('§2.3 prizes and §2.5 clamps', () => {
  it('prize = k × e × mult', () => {
    const b = roundBudget(1_000_000_000_000n, cfg) // ticket budget 4.5e9
    const W = 100n * MICRO // e.g. 100 weighted tickets
    expect(tierPrizeRaw(15n, b, MICRO, W)).toBe((b.ticketBudgetRaw * 15n) / 1000n) // 1.5e
    expect(tierPrizeRaw(500n, b, 2n * MICRO, 1_000n * MICRO)).toBe((b.ticketBudgetRaw * 50n * 2n) / 1_000n) // 50e × 2
    // 50e × 25 at W=100 would be 56.25 PUMP-units of 5% cap → clamped to exactly P/20
    expect(tierPrizeRaw(500n, b, 25n * MICRO, W)).toBe(b.singlePrizeCapRaw)
    expect(prizeForTierRaw(0, b, MICRO, W)).toBe(0n)
  })

  it('no prize and no e when nobody entered (W = 0)', () => {
    expect(tierPrizeRaw(500n, roundBudget(1_000_000n, cfg), MICRO, 0n)).toBe(0n)
    expect(perWeightedTicketEv(roundBudget(1_000_000_000n, cfg), 0n)).toEqual({ num: 0n, den: 1n })
    const e = perWeightedTicketEv(roundBudget(1_000_000_000_000n, cfg), 100n * MICRO)
    expect(e.num / e.den).toBe(45_000_000n) // 0.9B / 100
  })

  it('at default constants the 5% clamp cannot bind for ticket prizes (max is 50·0.9B/5 = 4.5% of P)', () => {
    const P = 1_000_000_000_000n
    const b = roundBudget(P, cfg)
    const solo = entryTerms(usd(60), cfg) // 5 tickets, mult 1 — the smallest possible W
    const p = tierPrizeRaw(500n, b, solo.multMicro, solo.weightMicro)
    expect(p).toBe((P * 45n) / 1_000n)
    expect(p < b.singlePrizeCapRaw).toBe(true)
  })

  it('the clamp binds at PAYOUT_RATE 0.8% (tier-max would be 7.2% of P)', () => {
    const hot = parseEconomyConfig({ PAYOUT_RATE: '0.008' })
    const P = 1_000_000_000_000n
    const b = roundBudget(P, hot)
    const solo = entryTerms(usd(60), hot)
    expect(tierPrizeRaw(500n, b, solo.multMicro, solo.weightMicro)).toBe(P / 20n)
  })
})

describe('§2.7 reveal-time re-check (void on dump)', () => {
  it('voids only when the $50 tier drops', () => {
    expect(shouldVoidOnRecheck(usd(520), usd(519), cfg)).toBe(false)
    expect(shouldVoidOnRecheck(usd(520), usd(499.99), cfg)).toBe(true)
    expect(shouldVoidOnRecheck(usd(60), usd(49), cfg)).toBe(true)
    expect(shouldVoidOnRecheck(usd(520), usd(9_999), cfg)).toBe(false)
  })

  it('whales above $25k (tickets and mult both capped) are not over-voided', () => {
    expect(holdingsTier(usd(30_000), cfg)).toBe(500n)
    expect(shouldVoidOnRecheck(usd(30_000), usd(25_000), cfg)).toBe(false)
    expect(shouldVoidOnRecheck(usd(30_000), usd(24_950), cfg)).toBe(true)
  })

  it('balance-level re-check: unchanged balance never voids; selling across a $50 tier at the snapshot price does', () => {
    const snapshotPrice = 520_000_000_000_000n // $0.00052 per token → 1,000,000 tokens = $520 (tier 10)
    const bal = 1_000_000_000_000n
    expect(shouldVoidOnRecheckBalances(bal, bal, 6, snapshotPrice, cfg)).toBe(false)
    expect(shouldVoidOnRecheckBalances(bal, bal + 1n, 6, snapshotPrice, cfg)).toBe(false)
    // sell ~4% → $499 at the snapshot price → tier 9 → void (the live price is not an input at all)
    expect(shouldVoidOnRecheckBalances(bal, 960_000_000_000n, 6, snapshotPrice, cfg)).toBe(true)
    // sell a sliver that stays inside tier 10 → keep
    expect(shouldVoidOnRecheckBalances(bal, 990_000_000_000n, 6, snapshotPrice, cfg)).toBe(false)
  })

  it('tier cap follows whichever of tickets/mult saturates later (non-default knobs)', () => {
    const k1 = parseEconomyConfig({ MULT_CAP: '4', TICKETS_PER_50: '1' }) // tickets saturate at $5,000
    expect(shouldVoidOnRecheck(usd(5_000), usd(4_000), k1)).toBe(true)
    const k2 = parseEconomyConfig({ MULT_CAP: '1', TICKET_CAP: '200' }) // tickets saturate at $2,000
    expect(shouldVoidOnRecheck(usd(2_000), usd(1_000), k2)).toBe(true)
    expect(shouldVoidOnRecheck(usd(2_000), usd(2_000), k2)).toBe(false)
    expect(holdingsTier(usd(1_000_000), cfg)).toBe(500n) // defaults unchanged
  })
})

describe('§2.4 jackpot seed + re-seed and §6 loss nudge', () => {
  it('J0 = 1% of the initial pool; after a hit J restarts from 0 and re-seeds from the next accrual', () => {
    const P0 = 50_000_000_000n
    const J0 = jackpotSeedRaw(P0)
    expect(J0).toBe(500_000_000n)
    const afterHit = 0n
    const b = roundBudget(P0 - J0, cfg)
    expect(accrueJackpot(afterHit, b)).toBe(b.jackpotAccrualRaw)
  })

  it('nudge: +$50 → +5 tickets below the cap, multiplier gain at the cap, nothing above $25k', () => {
    const a = holdMoreNudge(usd(120), cfg)
    expect(a.extraUsd).toBe(50n)
    expect(a.extraTickets).toBe(5n)
    const b = holdMoreNudge(usd(1_000), cfg)
    expect(b.extraTickets).toBe(0n)
    expect(b.multGainMicro).toBe(50_000n) // +0.05×
    const c = holdMoreNudge(usd(30_000), cfg)
    expect(c.maxed).toBe(true)
    const d = holdMoreNudge(usd(10), cfg) // not yet eligible: $60 would earn 5 tickets
    expect(d.extraTickets).toBe(5n)
  })
})

describe('flag: the jackpot is not wallet-split-proof (documented, §2.4 locked)', () => {
  it('splitting $25k into 25×$1k leaves ticket EV identical but gains ~10.5% total EV via extra jackpot rolls', () => {
    const others = { w: 10_000n * MICRO, tickets: 10_000n } // the rest of the round: 10,000 tickets at mult 1
    const whale = entryTerms(usd(25_000), cfg) // 100 tickets × mult 25
    const split = entryTerms(usd(1_000), cfg) // 100 tickets × mult 1, ×25 wallets
    const W1 = others.w + whale.weightMicro
    const W2 = others.w + 25n * split.weightMicro
    expect(W1).toBe(W2)
    const ticketShare = (w: bigint, W: bigint) => 0.9 * (Number(w) / Number(W))
    const jackpotShare = (t: bigint, T: bigint) => 0.1 * (Number(t) / Number(T)) // long-run share of the accrual
    const evWhale =
      ticketShare(whale.weightMicro, W1) + jackpotShare(whale.tickets, others.tickets + whale.tickets)
    const evSplit =
      ticketShare(25n * split.weightMicro, W2) +
      jackpotShare(25n * split.tickets, others.tickets + 25n * split.tickets)
    expect(ticketShare(whale.weightMicro, W1)).toBeCloseTo(ticketShare(25n * split.weightMicro, W2), 12)
    const gain = evSplit / evWhale - 1
    expect(gain).toBeGreaterThan(0.09)
    expect(gain).toBeLessThan(0.12)
  })
})
