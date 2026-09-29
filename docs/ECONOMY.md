# $SCRATCHY economy — implementation notes

Source of truth: [PLAN.md §2](../PLAN.md). Every formula and constant there is **locked** and implemented
exactly in [`packages/core`](../packages/core/src). This file documents how the math is carried in code,
the decisions made where the spec was silent or self-conflicting, and the flags that were raised instead of
changing a constant.

## Units

| Quantity                                                         | Carried as                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| PUMP amounts (pool, budgets, prizes, jackpot)                    | `bigint` base units ("raw"; PUMP has 6 decimals)                             |
| Rates / shares (PAYOUT_RATE, JACKPOT_SHARE, SINGLE_PRIZE_CAP, …) | exact parts-per-million `bigint`                                             |
| Whale multiplier                                                 | micro-units (`1.0 = 1_000_000n`), floor-rounded                              |
| Holdings H                                                       | micro-USD `bigint`                                                           |
| Prices                                                           | USD (or PUMP) per whole token × 1e18                                         |
| Odds                                                             | parts-per-million; outcomes compared against exact 53-bit integer thresholds |

No float ever sizes a payout. USD figures on the site are estimates (`12,500 PUMP (~$42)`) using the PUMP
price known at reveal time; the paid PUMP amount never changes with price and is never delayed for it.

## Formulas (PLAN §2)

- **Eligibility:** `H ≥ $50`. **Tickets:** `min(floor(H/50) × 5, 100)`. **Multiplier:** `clamp(H/1000, 1, 25)`.
  **Weight:** `w = tickets × mult`, `W = Σw` — [`eligibility.ts`](../packages/core/src/eligibility.ts).
  EV is linear in dollars held from $50 to $25,000 (`w = H/10` at every $50 step — tested), so splitting a bag
  gains nothing on ticket prizes.
- **Round budget:** `P` = pool snapshot; `B = PAYOUT_RATE × P`; `B` splits into the ticket budget
  (`B − floor(B/10)`, i.e. 0.9B) and the jackpot accrual (`floor(B/10)`), so the split is exact.
  **Prize:** `min(floor(k10 × ticketBudget × mult_µ / (10 × W_µ)), floor(0.05 × P))` — one floor, < 1 raw unit of
  rounding per ticket — [`budget.ts`](../packages/core/src/budget.ts).
- **Odds (§2.3):** 70 / 20 / 7 / 2.5 / 0.4 / 0.1 % → 0 / 1.5e / 5e / 8e / 25e / 50e. Σp = 1 exactly and EV = 1.0e
  exactly (rational arithmetic) — [`odds.ts`](../packages/core/src/odds.ts).
- **Jackpot (§2.4):** pot `J` accrues `floor(B/10)` every round (including rounds nobody plays); every scratched
  ticket rolls 1-in-50,000 for the whole pot, not multiplied by mult; seeded with 1% of the initial pool at the
  genesis round; after a hit it restarts from 0 and re-seeds from the next accrual.
- **Clamps (§2.5):** see decisions B and E below. Reserve: `MIN_POOL_RESERVE_USD` converted to PUMP at the last
  known price (rounded up); gas: PRIZE SOL < `MIN_GAS_SOL`.

## Pool accounting

```
PRIZE wallet PUMP  =  P (free pool)  +  J (jackpot pot)  +  outstanding (won, not yet landed)
P (snapshot)       =  balance at finalized commitment − J − payouts not landed by the snapshot slot
```

Unscratched and voided prizes never leave the wallet, so they are back in `P` at the next snapshot. Any PUMP
that arrives without a ledger entry (your seed deposit, a top-up, a stranger's dust) is **booked as a deposit**
and joins the next `P` — it never pauses payouts. Only an _unexplained outflow_ is treated as an emergency.

## Decisions (approved by you during planning)

|       | Spec conflict                                                                                                                                                                                      | Resolution                                                                                                                                                                                                                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | "Monte Carlo 10k rounds at 50/300/1500 tickets … never exceeds 3B". Exact math: at 50 tickets P(round > 3B) = 1.80e-4, so ≥1 exceedance in 10k rounds happens ~83% of the time with an honest RNG. | Strict never-exceeds at 300 and 1500. At 50, the test computes the exact probability by convolving the odds table and asserts the observed count stays under a Poisson upper bound (tail 1e-6). Mean = 0.9B ± 2% at all sizes. Fixed seeds.                                                                   |
| **B** | The jackpot usually exceeds both the 5% single-prize clamp (whenever < ~700 tickets/round are scratched) and 3×B.                                                                                  | The jackpot pays from its own earmarked pot; the 5% clamp and the 3×B breaker apply to **ticket prizes only**. Jackpot guard: payout == recorded pot, and the wallet must cover it.                                                                                                                           |
| **C** | `e = 0.9B/W` needs the whole entrant set fixed when tickets are pre-rolled.                                                                                                                        | Wallets active on the site during round N (paste, or a visible-tab heartbeat from the session holding that wallet's lock) are entered into round N+1's drop. Holdings snapshot, W, and every ticket are fixed at the drop. First-time pasters get a countdown and a free no-prize practice ticket.            |
| **D** | Paying ATA rent on every first win is farmable (close the account, win again).                                                                                                                     | Spec kept: rent is paid every time, instantly. A SCRATCH ALL batch's wins for one wallet are coalesced into one transfer, a farming-pattern alert fires, and `ATA_RECREATE_LIMIT` (default 0 = unlimited) exists if you ever want it.                                                                         |
| **E** | §2.5 says the breaker "pauses and fires an alert" but not how it resumes.                                                                                                                          | Fully automatic: the tripping payout and every later ticket-prize payout in that round are held; at the round boundary every revealed prize is re-derived from the revealed seed and stored params; all match → auto-release + resume ("variance trip, verified"); any mismatch → hard stop until you resume. |

Interpretations: "5% of **current** pool" is the round's snapshot P (so /fair can reproduce every prize); at
default constants the clamp can't bind for ticket prizes (the largest possible is 50·0.9B/5 = 4.5% of P) — it
binds above PAYOUT_RATE ≈ 0.56% (tested at 0.8%). "Dumped below its snapshot tier" = the $50 bracket
`min(floor(H/50), 500)` with **both** H values priced at the snapshot price, so price moves never void anyone.

## Flags raised (constants unchanged)

1. **Breaker trips on variance at low participation.** P(round > 3B) = 3.2% / 2.5% / 1.1% at 5 / 10 / 20 tickets in
   play → ~1.5–4.6 trips/day at a quiet launch. Decision E makes these self-healing.
2. **Dust vs rent.** At §2.6's own equilibrium ($1,167 pool) a 1.5e hit is ~$0.08 at 100 tickets and < $0.01 at
   2,000, while a first-time winner's Token-2022 PUMP account costs ~0.0021 SOL of rent from the hot wallet.
3. **§2.6 text.** "Tier-max wins well over $100" is not reachable at a $1,167 pool — the largest possible single
   win is ~$52.50 (one $50 holder alone). It needs a pool of ~$2.2k+. Everything scales linearly with the pool.
4. **Fee inflow.** Meteora keeps 20% of the pool fee, so CREATOR claims ~2.4% of volume (× CREATOR's share of the
   pool's liquidity). `pnpm sim` shows both the spec's 3% figures and the post-cut figures.
5. **Jackpot and wallet-splitting.** Jackpot rolls are per ticket and tickets cap at 100 (~$1k), so splitting a
   bag above $1k across wallets multiplies jackpot rolls: $25k split into 25 × $1k wallets keeps ticket-prize EV
   identical but gains ~10.5% total EV (pinned by a test). The anti-sybil guarantee holds for the 90% ticket
   budget, not the 10% jackpot. Options if you want to close it (each changes a locked §2.4 rule): one jackpot roll
   per wallet per round, or jackpot odds weighted by `w`. J also keeps accruing in live rounds nobody plays and can
   grow larger than the free pool.
6. **Low volume vs the reserve.** With MIN_POOL_RESERVE_USD = $300 and PAYOUT_RATE 0.5%, the pool needs ≥ $216/day
   of inflow (≈ $12.9k/day of volume after Meteora's cut) to sit above the reserve; below that the engine skips
   rounds until inflow refills it. From an empty pool at $40k/day the first ~71 rounds (~12 h) are skipped — the
   launch seed deposit avoids that.
7. **Two jackpot hits in one round:** the first reveal takes the pot; a second gets what's left (≈ 0) with an
   "already claimed this round" treatment.

## Pauses and how they resume

| Pause              | Trigger                                                                                                                                                                                | Resume                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `breaker`          | a round's realized ticket payouts would exceed 3×B                                                                                                                                     | automatic at the round boundary if every prize re-derives correctly (E) |
| `breaker_mismatch` | a revealed prize does not match its seed recomputation                                                                                                                                 | **manual** (admin)                                                      |
| `low_pool`         | P < MIN_POOL_RESERVE (USD→PUMP at last known price; no price ever known → fail closed). Rounds that start below the reserve are **skipped**: no tickets, no budget, no jackpot accrual | automatic at threshold × (1 + RESERVE_HYSTERESIS)                       |
| `low_gas`          | PRIZE SOL < MIN_GAS_SOL                                                                                                                                                                | automatic at threshold × (1 + RESERVE_HYSTERESIS)                       |
| `invariant`        | an **unexplained outflow** from the PRIZE wallet (possible key compromise)                                                                                                             | **manual** (admin)                                                      |
| `manual`           | admin                                                                                                                                                                                  | admin                                                                   |

While paused, scratches still reveal and wins queue — nothing is ever dropped. Reserve and gas pauses also hold
jackpot payouts; the breaker never holds a jackpot. Every pause, resume, breaker event, sweep and payout goes to
Postgres and Telegram.

## `pnpm sim`

Prints the §2.6 sustainability table: the spec's worked example with and without Meteora's cut, equilibrium by
daily volume, the prize ladder by participation (PUMP and ~$), exact breaker-trip rates, jackpot size vs pool,
a 30-day trajectory from an empty pool, and SOL gas. Flags: `--pump-usd`, `--sol-usd`, `--meteora-cut`,
`--lp-share`, `--volume 10000,40000,…`.
