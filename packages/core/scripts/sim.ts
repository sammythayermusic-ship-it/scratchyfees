/**
 * `pnpm sim` — PLAN.md §2.6 sustainability table.
 *
 *   pnpm sim                                  defaults: PUMP $0.0056, Meteora keeps 20%, CREATOR owns 100% of LP
 *   pnpm sim -- --pump-usd 0.004 --lp-share 0.5 --volume 40000,250000
 *
 * Everything is computed with the same core functions the API ships (bigint PUMP amounts, exact odds).
 */
import {
  DEFAULT_ECONOMY,
  entryTerms,
  formatPump,
  poolReserveRaw,
  roundBudget,
  tierPrizeRaw,
  TIERS,
  type EconomyConfig,
} from '../src/index'
import { exceedanceProbability, simulatePool, uniformWallets } from '../src/sim'

const exact = exceedanceProbability

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '')
}
const PUMP_USD = Number(args.get('pump-usd') ?? 0.0056)
const METEORA_CUT = Number(args.get('meteora-cut') ?? 0.2)
const LP_SHARE = Number(args.get('lp-share') ?? 1)
const SOL_USD = Number(args.get('sol-usd') ?? 200)
const VOLUMES = (args.get('volume') ?? '10000,40000,100000,250000,1000000').split(',').map(Number)
const cfg: EconomyConfig = DEFAULT_ECONOMY
const DEC = 6
const RPD = Math.round(86_400 / cfg.roundSeconds)

const pumpRaw = (usd: number) => BigInt(Math.round((usd / PUMP_USD) * 10 ** DEC))
const usdOf = (raw: bigint) => (Number(raw) / 10 ** DEC) * PUMP_USD
const $ = (usd: number) =>
  usd >= 100 ? `$${Math.round(usd).toLocaleString('en-US')}` : usd >= 0.01 ? `$${usd.toFixed(2)}` : '<$0.01'
const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 3 : 1)}%`
const sci = (x: number) => (x === 0 ? '0' : x < 1e-12 ? '<1e-12' : x.toExponential(2))
const pad = (s: string, n: number) => s.padStart(n)
const line = (cols: string[], widths: number[]) => cols.map((c, i) => pad(c, widths[i]!)).join('  ')

function table(title: string, head: string[], rows: string[][]) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  console.log(`\n${title}`)
  console.log(line(head, widths))
  console.log(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(r, widths))
}

const feeShare = Number(cfg.poolTradingFeePpm) / 1e6
const poolSplit = Number(cfg.feeSplitPoolPpm) / 1e6
const rate = Number(cfg.payoutRatePpm) / 1e6
const inflowUsd = (vol: number, cut: number) => vol * feeShare * (1 - cut) * LP_SHARE * poolSplit

console.log('$SCRATCHY sustainability simulation (PLAN.md §2.6)')
console.log(
  `PAYOUT_RATE ${pct(rate)}/round × ${RPD} rounds/day · jackpot share ${pct(Number(cfg.jackpotSharePpm) / 1e6)} · ` +
    `1-in-${cfg.jackpotOdds} jackpot · clamp ${pct(Number(cfg.singlePrizeCapPpm) / 1e6)} of P · breaker ${Number(cfg.roundBreakerPpm) / 1e6}×B`,
)
console.log(
  `Assumptions: PUMP = $${PUMP_USD} · pool fee ${pct(feeShare)} · Meteora protocol cut ${pct(METEORA_CUT)} · ` +
    `CREATOR share of LP ${pct(LP_SHARE)} · ${pct(poolSplit)} of claims → prize pool · SOL = $${SOL_USD}`,
)
console.log('All pool/prize math is in PUMP; every $ figure is an estimate at the PUMP price above.')

// ── 1. The spec's own worked example ─────────────────────────────────────────
{
  const specInflow = 40_000 * feeShare * poolSplit
  const eqSpec = specInflow / RPD / rate
  const realInflow = inflowUsd(40_000, METEORA_CUT)
  const eqReal = realInflow / RPD / rate
  table(
    '1) §2.6 worked example — $40k/day volume',
    ['case', 'pool inflow/day', 'equilibrium pool', 'days of inflow', 'B / round', '0.9B / round'],
    [
      [
        'spec text (3% × 70%)',
        $(specInflow),
        $(eqSpec),
        (eqSpec / specInflow).toFixed(2),
        $(eqSpec * rate),
        $(eqSpec * rate * 0.9),
      ],
      [
        `after Meteora ${pct(METEORA_CUT)} cut`,
        $(realInflow),
        $(eqReal),
        (eqReal / realInflow).toFixed(2),
        $(eqReal * rate),
        $(eqReal * rate * 0.9),
      ],
    ],
  )
  const b = roundBudget(pumpRaw(eqSpec), cfg)
  const solo = entryTerms(60_000_000n, cfg)
  const maxTierMax = tierPrizeRaw(500n, b, solo.multMicro, solo.weightMicro)
  console.log(
    `   Largest possible single-ticket win at that pool (one $50 holder alone, 50e): ${formatPump(maxTierMax, DEC)} PUMP ` +
      `(~${$(usdOf(maxTierMax))}). The spec's "tier-max wins well over $100" needs a pool ≳ ${$(
        (100 / usdOf(maxTierMax)) * eqSpec,
      )}.`,
  )
}

// ── 2. Volume scenarios ──────────────────────────────────────────────────────
table(
  '2) Equilibrium by daily trading volume (pool ≈ 1.39 days of inflow)',
  [
    'volume/day',
    'pool inflow/day',
    'equilibrium pool',
    'pool (PUMP)',
    'B / round',
    'jackpot accrual/day',
    'vs reserve',
  ],
  VOLUMES.map((v) => {
    const inflow = inflowUsd(v, METEORA_CUT)
    const eq = inflow / RPD / rate
    const reserveUsd = Number(cfg.minPoolReserveUsd)
    return [
      $(v),
      $(inflow),
      $(eq),
      formatPump(pumpRaw(eq), DEC),
      $(eq * rate),
      $(eq * rate * 0.1 * RPD),
      eq < reserveUsd ? `BELOW $${reserveUsd} → mostly paused` : 'ok',
    ]
  }),
)
{
  const reserveUsd = Number(cfg.minPoolReserveUsd)
  const minInflow = reserveUsd * rate * RPD
  const minVolume = minInflow / (feeShare * (1 - METEORA_CUT) * LP_SHARE * poolSplit)
  console.log(
    `   MIN_POOL_RESERVE ($${reserveUsd}) needs ≥ ${$(minInflow)}/day into the pool ≈ ${$(minVolume)}/day of volume ` +
      `to keep rounds running; below that the engine skips rounds until inflow refills the pool.`,
  )
}

// ── 3. Prize ladder by participation ─────────────────────────────────────────
for (const vol of [40_000, VOLUMES.at(-2) ?? 250_000]) {
  const eqUsd = inflowUsd(vol, METEORA_CUT) / RPD / rate
  const P = pumpRaw(eqUsd)
  const b = roundBudget(P, cfg)
  const rows = [5, 20, 50, 100, 300, 1500, 5000].map((W) => {
    const Wm = BigInt(W) * 1_000_000n
    const prize = (k10: bigint) => usdOf(tierPrizeRaw(k10, b, 1_000_000n, Wm))
    const pEx = W <= 1500 ? exact(W) : 0
    // mean rounds between hits for W scratched tickets (geometric), pot = accrual × rounds (the 1% seed is launch-only)
    const pHit = 1 - Math.pow(1 - 1 / Number(cfg.jackpotOdds), W)
    const roundsBetweenJackpots = 1 / pHit
    const jackpotAtHit = usdOf(b.jackpotAccrualRaw) * roundsBetweenJackpots
    return [
      String(W),
      $(prize(10n)),
      $(prize(15n)),
      $(prize(50n)),
      $(prize(80n)),
      $(prize(250n)),
      $(prize(500n)),
      sci(pEx),
      (pEx * RPD).toFixed(pEx * RPD < 0.01 ? 4 : 2),
      `${(roundsBetweenJackpots / RPD).toFixed(1)}d`,
      `${$(jackpotAtHit)} (${pct(jackpotAtHit / usdOf(P))})`,
    ]
  })
  table(
    `3) Prizes by participation — ${$(vol)}/day volume, pool ≈ ${$(eqUsd)} (${formatPump(P, DEC)} PUMP), mult 1`,
    [
      'W tickets',
      'e',
      '1.5e',
      '5e',
      '8e',
      '25e',
      '50e',
      'P(round>3B)',
      'trips/day',
      'jackpot every',
      'avg jackpot at hit',
    ],
    rows,
  )
}
console.log(
  '   Whale prizes scale with mult (up to 25×) while their share of W grows equally, so EV stays linear in $ held.',
)
console.log(
  `   Jackpot column: at low participation the pot exceeds the 5% clamp (below ~500 tickets/round) and 3×B (below ~1,700) — why Decision B exempts it.`,
)

// ── 4. 30-day trajectory from an empty pool ───────────────────────────────────
{
  const vol = 40_000
  const inflowRaw = pumpRaw(inflowUsd(vol, METEORA_CUT))
  const res = simulatePool({
    cfg,
    days: 30,
    initialPoolRaw: 0n,
    inflowPerDayRaw: inflowRaw,
    wallets: uniformWallets(300),
    seed: 2026,
    seedJackpot: false,
    reserveRaw: poolReserveRaw(cfg, BigInt(Math.round(PUMP_USD * 1e18)), DEC) ?? 0n,
  })
  const eq = res.equilibriumRaw
  const pick = [1, 2, 3, 5, 7, 14, 21, 30]
  table(
    `4) 30-day pool trajectory from $0 — ${$(vol)}/day, 300 tickets scratched per round (stochastic)`,
    ['day', 'pool (end of day)', '% of equilibrium', 'jackpot pot'],
    pick.map((d) => {
      const r = res.rounds.filter((x) => x.day === d - 1).at(-1)!
      return [String(d), $(usdOf(r.poolRaw)), pct(Number(r.poolRaw) / Number(eq)), $(usdOf(r.jackpotRaw))]
    }),
  )
  console.log(
    `   30 days: paid ${$(usdOf(res.totalPaidRaw))} in ticket prizes + ${$(usdOf(res.totalJackpotPaidRaw))} in ${res.jackpotHits} jackpot(s); ` +
      `${res.skippedRounds} round(s) skipped while the pool was below the $${cfg.minPoolReserveUsd} reserve; pool never drains.`,
  )
}

// ── 5. Breaker exact tail + SOL gas ──────────────────────────────────────────
{
  table(
    '5) Round breaker (3×B) — exact probability a round trips it on variance alone',
    ['tickets in play', 'P(round > 3B)', 'expected trips/day', 'P(≥1 in 10k rounds)'],
    [5, 10, 20, 50, 100, 300].map((n) => {
      const p = exceedanceProbability(n)
      return [String(n), sci(p), (p * RPD).toFixed(4), pct(1 - Math.pow(1 - p, 10_000))]
    }),
  )
  const lamportsPerTx = 5_000 + Math.round((20_000 * 80_000) / 1e6) // base fee + priority (20k µlamports × 80k CU)
  const ataRent = (175 + 128) * 3_480 * 2 // Token-2022 PUMP account (175 bytes), rent-exempt minimum
  table(
    '6) PRIZE wallet SOL gas (fees + PUMP token-account rent for first-time winners)',
    ['winning payouts/day', 'tx fees/day (SOL)', '≈ $', 'rent per new winner (SOL)', '≈ $'],
    [100, 1_000, 10_000].map((n) => [
      n.toLocaleString('en-US'),
      ((n * lamportsPerTx) / 1e9).toFixed(4),
      $(((n * lamportsPerTx) / 1e9) * SOL_USD),
      (ataRent / 1e9).toFixed(5),
      $((ataRent / 1e9) * SOL_USD),
    ]),
  )
  console.log(
    `   Keep PRIZE ≥ MIN_GAS_SOL (${Number(cfg.minGasLamports) / 1e9} SOL) plus headroom; payouts pause below it.`,
  )
}

// TIERS is imported to keep this script honest if the odds table ever changes shape.
if (TIERS.length !== 6) throw new Error('odds table shape changed — update the sim table')
