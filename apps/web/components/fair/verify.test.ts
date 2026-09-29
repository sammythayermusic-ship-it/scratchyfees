import { CUMULATIVE_PPM, recomputeTicket } from '@scratchy/core'
import { describe, expect, it } from 'vitest'
import vectorsFile from '../../../../packages/core/test/fixtures/fair-vectors.json'
import {
  checkRoundMath,
  checkSeed,
  multExact,
  parseRoundInput,
  parseTicketInput,
  pickDefaultRound,
  planSamplePage,
  ppmPercent,
  pumpExact,
  pythonCheck,
  recentEndedRounds,
  roundParamsFromApi,
  summarize,
  ticketProof,
  verifyWalletTickets,
  type FairEntry,
  type FairRoundData,
  type StoredTicket,
} from './verify'

/** A real ended round captured from the dev API (memory mode), incl. the server's stored tickets #0–#13. */
const ROUND_10: FairRoundData = {
  id: 10,
  status: 'ended',
  startsAt: '2026-09-29T20:55:00.000Z',
  endsAt: '2026-09-29T20:56:00.000Z',
  seedHash: '12ab1caf67044e2e7769b511187dc9df5fc1dd3a2e42348f295207d08c33aebf',
  serverSeed: '9ca119b222d5225ee9e2a3991e3d9df2777485f4a4a08afd8a8a254fd1dbea87',
  poolRaw: '263909983259',
  budgetRaw: '1319549916',
  ticketBudgetRaw: '1187594925',
  jackpotAccrualRaw: '131954991',
  singlePrizeCapRaw: '13195499162',
  payoutRatePpm: '5000',
  jackpotSharePpm: '100000',
  singlePrizeCapPpm: '50000',
  roundBreakerPpm: '3000000',
  jackpotOdds: '50000',
  totalWeightedMicro: '143989300',
  skipReason: null,
}
const WALLET_10 = 'FFzSAG5h28LQcGp42refPAhXFfCo7M6sUFuDXHLivDu8'
const ENTRY_10: FairEntry = {
  wallet: WALLET_10,
  tickets: 100,
  multMicro: '1439893',
  holdingsUsdMicro: '1439893901',
}
const STORED_10_ROWS: [idx: number, tier: number, prizeRaw: string][] = [
  [0, 1, '17813923'],
  [1, 0, '0'],
  [2, 1, '17813923'],
  [3, 1, '17813923'],
  ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((i): [number, number, string] => [i, 0, '0']),
]
const STORED_10: StoredTicket[] = STORED_10_ROWS.map(([idx, tier, prizeRaw]) => ({
  idx,
  tier,
  jackpot: false,
  prizeRaw,
  scratched: null,
  void: false,
}))

const params10 = () => {
  const r = roundParamsFromApi(ROUND_10)
  if (!r.ok) throw new Error('params missing')
  return r.params
}

describe('inputs', () => {
  it('parses round ids', () => {
    expect(parseRoundInput('12')).toBe(12)
    expect(parseRoundInput(' #12 ')).toBe(12)
    expect(parseRoundInput('0')).toBeNull()
    expect(parseRoundInput('-1')).toBeNull()
    expect(parseRoundInput('1.5')).toBeNull()
    expect(parseRoundInput('')).toBeNull()
    expect(parseRoundInput(undefined)).toBeNull()
  })
  it('parses ticket indexes', () => {
    expect(parseTicketInput('')).toBeNull()
    expect(parseTicketInput('0')).toBe(0)
    expect(parseTicketInput('#7')).toBe(7)
    expect(parseTicketInput('x')).toBe('invalid')
  })
})

describe('round params', () => {
  it('maps the API round onto core RoundParams', () => {
    expect(params10()).toEqual({
      roundId: 10,
      poolRaw: 263909983259n,
      payoutRatePpm: 5000n,
      jackpotSharePpm: 100000n,
      singlePrizeCapPpm: 50000n,
      roundBreakerPpm: 3000000n,
      jackpotOdds: 50000n,
      totalWeightMicro: 143989300n,
    })
  })
  it('reports missing params instead of guessing', () => {
    const r = roundParamsFromApi({ ...ROUND_10, poolRaw: null, jackpotOdds: null })
    expect(r).toEqual({ ok: false, missing: ['poolRaw', 'jackpotOdds'] })
  })
  it('re-derives the stored budget, cap and W', () => {
    const checks = checkRoundMath(ROUND_10, params10(), [ENTRY_10])
    expect(checks.map((c) => c.status)).toEqual(['match', 'match', 'match', 'match', 'match'])
    const bad = checkRoundMath({ ...ROUND_10, singlePrizeCapRaw: '1' }, params10(), [ENTRY_10])
    expect(bad.find((c) => c.key === 'singlePrizeCap')!.status).toBe('mismatch')
    const noW = checkRoundMath(
      ROUND_10,
      params10(),
      Array.from({ length: 5_000 }, () => ENTRY_10),
    )
    expect(noW.find((c) => c.key === 'totalWeight')!.status).toBe('unavailable')
  })
})

describe('seed commitment', () => {
  it('matches the real round', () => {
    expect(checkSeed(ROUND_10.serverSeed!, ROUND_10.seedHash)).toEqual({
      status: 'match',
      computedHash: ROUND_10.seedHash,
    })
  })
  it('flags a swapped seed and malformed input', () => {
    const other = vectorsFile.vectors[0]!
    expect(checkSeed(other.seed, ROUND_10.seedHash).status).toBe('mismatch')
    expect(checkSeed('zz', ROUND_10.seedHash)).toEqual({ status: 'malformed', computedHash: null })
  })
})

describe('tickets', () => {
  it('recomputes the real stored tickets exactly', () => {
    const entry = { ...ENTRY_10, tickets: STORED_10.length }
    const v = verifyWalletTickets(ROUND_10.serverSeed!, params10(), entry, STORED_10)
    expect(v.issues).toEqual([])
    expect(v.rows).toHaveLength(14)
    expect(v.rows.every((r) => r.match)).toBe(true)
    expect(summarize(v.rows)).toMatchObject({ total: 14, matched: 14, mismatched: 0, wins: 3, jackpots: 0 })
    expect(summarize(v.rows).totalPrizeRaw).toBe(3n * 17813923n)
  })

  it('makes tampering visible: wrong tier, wrong prize, flipped jackpot, missing ticket', () => {
    const tampered = STORED_10.map((t) =>
      t.idx === 1
        ? { ...t, tier: 5 }
        : t.idx === 2
          ? { ...t, prizeRaw: '17813924' }
          : t.idx === 3
            ? { ...t, jackpot: true }
            : t,
    ).filter((t) => t.idx !== 4)
    const entry = { ...ENTRY_10, tickets: STORED_10.length }
    const v = verifyWalletTickets(ROUND_10.serverSeed!, params10(), entry, tampered)
    const bad = v.rows.filter((r) => !r.match)
    expect(bad.map((r) => r.idx)).toEqual([1, 2, 3, 4])
    expect(bad[0]).toMatchObject({ tierOk: false, jackpotOk: true, prizeOk: true })
    expect(bad[1]).toMatchObject({ tierOk: true, prizeOk: false })
    expect(bad[2]).toMatchObject({ jackpotOk: false })
    expect(bad[3]!.stored).toBeNull()
    expect(v.issues).toHaveLength(1)
  })

  it('verifies a single ticket index, and rejects one past the entry', () => {
    const one = verifyWalletTickets(ROUND_10.serverSeed!, params10(), ENTRY_10, STORED_10, 2)
    expect(one.rows.map((r) => [r.idx, r.match])).toEqual([[2, true]])
    const none = verifyWalletTickets(ROUND_10.serverSeed!, params10(), ENTRY_10, STORED_10, 100)
    expect(none.rows).toEqual([])
    expect(none.issues[0]).toMatch(/doesn't exist/)
  })
})

describe('ticket proof', () => {
  it('reproduces the independent Python vectors byte-for-byte', () => {
    for (const vec of vectorsFile.vectors) {
      const p = ticketProof(
        vec.seed,
        {
          roundId: vec.roundId,
          poolRaw: 0n,
          payoutRatePpm: 0n,
          jackpotSharePpm: 0n,
          singlePrizeCapPpm: 0n,
          roundBreakerPpm: 0n,
          jackpotOdds: 50_000n,
          totalWeightMicro: 0n,
        },
        vec.wallet,
        vec.idx,
        1_000_000n,
      )
      expect(p.digestHex).toBe(vec.digest)
      expect(p.x).toBe(BigInt(vec.x))
      expect(p.y).toBe(BigInt(vec.y))
      expect(p.tier).toBe(vec.tier)
      expect(p.jackpot).toBe(vec.jackpot)
      expect(p.bytesTier + p.bytesJackpot).toBe(vec.digest.slice(0, 32))
      expect(p.upperPpm).toBe(CUMULATIVE_PPM[vec.tier])
    }
  })

  it('shows the prize before and after the single-prize cap', () => {
    const p = ticketProof(ROUND_10.serverSeed!, params10(), WALLET_10, 0, 1_439_893n)
    expect(p.message).toBe(`${WALLET_10}:10:0`)
    expect(p.tier).toBe(1)
    expect(p.lowerPpm).toBe(700_000n)
    expect(p.upperPpm).toBe(900_000n)
    expect(p.prizeRaw).toBe(17813923n)
    expect(p.uncappedPrizeRaw).toBe(17813923n)
    expect(p.capped).toBe(false)
    // a whale multiplier on a tiny W pushes the prize into the cap
    const capped = ticketProof(
      ROUND_10.serverSeed!,
      { ...params10(), totalWeightMicro: 1_000_000n },
      WALLET_10,
      0,
      25_000_000n,
    )
    expect(capped.capped).toBe(true)
    expect(capped.prizeRaw).toBe(13195499162n)
    expect(capped.prizeRaw).toBe(
      recomputeTicket(ROUND_10.serverSeed!, WALLET_10, 0, 25_000_000n, {
        ...params10(),
        totalWeightMicro: 1_000_000n,
      }).prizeRaw,
    )
  })
})

describe('sampling and defaults', () => {
  const e = (tickets: number, i: number): FairEntry => ({
    wallet: `w${i}`,
    tickets,
    multMicro: '1000000',
    holdingsUsdMicro: '0',
  })
  it('pages ~100 tickets at a time, at least one wallet', () => {
    const entries = [60, 30, 20, 100, 5].map(e)
    expect(planSamplePage(entries, 0)).toEqual({ wallets: entries.slice(0, 3), next: 3 })
    expect(planSamplePage(entries, 3)).toEqual({ wallets: [entries[3]], next: 4 })
    expect(planSamplePage(entries, 4)).toEqual({ wallets: [entries[4]], next: null })
    expect(
      planSamplePage(
        Array.from({ length: 40 }, (_, i) => e(1, i)),
        0,
      ).wallets,
    ).toHaveLength(25)
  })
  it('defaults to the latest ended round with tickets', () => {
    const history = [
      { id: 7, status: 'ended', tickets: 100 },
      { id: 8, status: 'ended', tickets: 0 },
      { id: 9, status: 'skipped', tickets: 0 },
      { id: 10, status: 'live', tickets: 100 },
    ]
    expect(pickDefaultRound(history, null)).toBe(7)
    expect(
      pickDefaultRound(
        history.map((h) => ({ ...h, tickets: 0 })),
        null,
      ),
    ).toBe(8)
    expect(pickDefaultRound([], { id: 13, status: 'live' })).toBe(12)
    expect(pickDefaultRound(null, { id: 1, status: 'live' })).toBeNull()
    expect(recentEndedRounds(history).map((r) => r.id)).toEqual([8, 7])
  })
})

describe('display', () => {
  it('formats exact PUMP, rates and multipliers', () => {
    expect(pumpExact(17813923n)).toBe('17.813923')
    expect(pumpExact('262488073605')).toBe('262,488.073605')
    expect(pumpExact(0n)).toBe('0')
    expect(pumpExact(5_000_000_000n)).toBe('5,000')
    expect(ppmPercent(5000n)).toBe('0.5%')
    expect(ppmPercent('100000')).toBe('10%')
    expect(multExact('1439893')).toBe('1.439893×')
  })
  it('emits an offline script whose tables come from core', () => {
    const s = pythonCheck({
      roundId: 10,
      serverSeed: ROUND_10.serverSeed!,
      seedHash: ROUND_10.seedHash,
      poolRaw: ROUND_10.poolRaw!,
      payoutRatePpm: ROUND_10.payoutRatePpm!,
      jackpotSharePpm: ROUND_10.jackpotSharePpm!,
      singlePrizeCapPpm: ROUND_10.singlePrizeCapPpm!,
      jackpotOdds: ROUND_10.jackpotOdds!,
      totalWeightedMicro: ROUND_10.totalWeightedMicro!,
      entries: [ENTRY_10],
    })
    expect(s).toContain('CUM = [700000, 900000, 970000, 995000, 999000, 1000000]')
    expect(s).toContain('K10 = [0, 15, 50, 80, 250, 500]')
    expect(s).toContain(`"${WALLET_10}": (100, 1439893),`)
    expect(pythonCheck(null)).toContain('<serverSeed hex>')
  })
})
