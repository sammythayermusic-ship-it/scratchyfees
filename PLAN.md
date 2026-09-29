# $SCRATCHY — Master Build Plan

**Holder-rewards scratch tickets on Solana, paid in $PUMP from the coin's 3% trading fee.**
This document is the complete build spec. Claude Code: read it fully, then execute the Build Phases in order. All economic formulas here are final and test-enforced — do not change constants without flagging it.

---

## 1. Concept

Paste your Solana wallet into **scratchyfees.fun** (domain live, registered on Cloudflare; official X: **@ScratchyFees**). No wallet connect, no signature, no deposit. If you're holding at least $50 of $SCRATCHY, colorful scratch-off tickets drop on your screen every 10 minutes. Scratch them with your finger/mouse. Winners get **$PUMP** paid **instantly and automatically** to the wallet they're holding with — a huge "YOU WIN 12,500 PUMP (~$42)" celebration fires, and one tap shares the win to X. The prize pool is filled by the coin's **3% trading fee on its PUMP pair** (same architecture as cockfight, PUMP-paired instead of GME): 70% of fees to the pool, 30% to operations. Bigger market cap → more trading → more fees → visibly bigger prizes, live on the site.

Why paste-only is safe: **payouts always go to the pasted holder wallet itself.** Pasting someone else's wallet just scratches on their behalf and pays *them*. There is nothing to steal, so no signature is needed. This is a core design win — say it in the FAQ.

### Locked product decisions
- Launch: **$SCRATCHY paired with $PUMP** (mint: `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`), **3% trading fee on the pool**; the fee is the prize-pool source and **all prizes pay out in $PUMP tokens** — same fees-pay-winners architecture as cockfight. Launch venue must support a PUMP quote pair with a 3% fee claimable by the creator (Meteora DAMM v2-style pool with custom quote + fee collection, or equivalent; ⚠️ FLAG: confirm the exact launchpad/AMM with Sammy before Phase 2 chain work, and build the fee-sweeper behind an adapter interface so the venue is swappable)
- Payout precision: a win's displayed USD value is an estimate; the paid amount is exact **in PUMP**, converted at the price known at reveal time. PUMP's price moves, so "close enough" is the explicit contract — never block or delay a payout chasing exact USD equivalence
- Tickets scale with holdings, capped, with a **whale multiplier** above the cap
- Payouts: **fully automatic, instant, everything including jackpots** (hot wallet signs with no human in the loop; hard clamps + circuit breaker are the only safeties)
- Tickets: **2.5D** — real canvas scratching with foil texture, 3D tilt, holo shine, particles, confetti
- Live pool, live winners feed, optional X handle, one-tap win sharing

---

## 2. The Economy (final math — implement exactly, cover with tests)

### 2.1 Eligibility & tickets
Let `H` = USD value of the wallet's $SCRATCHY at the round snapshot.

| Rule | Value |
|---|---|
| Minimum to play | `H ≥ $50` |
| Tickets per round | `tickets = min(floor(H / 50) × 5, 100)` (cap = $1,000 → 100 tickets) |
| Whale multiplier | `mult = clamp(H / 1000, 1, 25)` — applies to every prize on that wallet's tickets |
| Weighted tickets | `w = tickets × mult`; round total `W = Σ w` |

The multiplier keeps expected value **linear in dollars held from $50 up to $25,000**, so splitting a big bag across many wallets gains nothing (this is the anti-sybil design, not an afterthought). Above $25k EV flattens — acceptable pool protection.

### 2.2 Rounds & budget
- A round is **10 minutes**, 144/day, synchronized on the clock (`:00, :10, ...`).
- At round start, snapshot pool balance `P` in **PUMP tokens**. The pool, budgets, and every prize are denominated in PUMP internally — the math is all percentages of `P`, so PUMP's USD price can swing freely without ever breaking the economy or over-paying the pool. The site displays prizes as `X PUMP (~$Y)` where the USD figure is an at-that-moment estimate. Round budget `B = PAYOUT_RATE × P`, default `PAYOUT_RATE = 0.005` (0.5%).
- `B` splits: **90% ticket prizes, 10% accrues to the progressive JACKPOT pot**.
- Per-weighted-ticket expected value: `e = 0.9 × B / W`.

### 2.3 Per-ticket odds table (prizes in units of `e`, then × the wallet's `mult`)

| Probability | Prize | Feel |
|---|---|---|
| 70.0% | 0 | loser (make the reveal still fun) |
| 20.0% | 1.5e | small hit |
| 7.0% | 5e | nice hit |
| 2.5% | 8e | big hit |
| 0.4% | 25e | HUGE |
| 0.1% | 50e | TIER-MAX 🚨 |

Verified: probabilities sum to 1.000000, EV = exactly `1.0e`, so expected round payout = `0.9B`. ~30% of tickets win *something* — the dopamine loop lives here.

### 2.4 Progressive JACKPOT
- Pot `J` accrues `0.1 × B` every round and is displayed on the site as a climbing meter.
- Every scratched ticket independently rolls **1-in-50,000** to hit the ENTIRE pot (× NOT multiplied by `mult` — the jackpot is the same glory for everyone).
- Seed `J` at launch with 1% of the initial pool. After a hit, it re-seeds from the next round's accrual.

### 2.5 Safety clamps (automatic, no human)
- Any single prize is clamped to **5% of current pool**.
- If a round's realized payouts exceed **3 × B**, the payout engine pauses and fires an alert (Telegram + log). Simulation: with just 50 tickets in play, worst case over 2,000 trials was 2.85B; at 300+ tickets, max 1.43B. Statistically this trips only on a bug — which is exactly what it's for.
- Payouts pause automatically if pool balance < `MIN_POOL_RESERVE` (default: PUMP worth ~$300 at last known price), or if the hot wallet's SOL gas balance < `MIN_GAS_SOL` (default 0.1 SOL — SPL token transfers still burn SOL for fees and ATA rent).

### 2.6 Sustainability (simulated, 30 days)
At 0.5%/round the pool pays out ~51% of itself per day with zero inflow — but it converges, never drains: equilibrium pool ≈ **1.4 days of fee inflow** (e.g. $40k/day of trading volume × 3% fee × 70% share = $840/day into the pool → pool stabilizes around ~$1,170 worth of PUMP, round budget ~$5.80, with tier-max single-ticket wins well over $100 at modest participation — all held and paid as PUMP, so these USD figures float with PUMP's price). Prizes scale automatically with volume: pump harder → pool grows → every number on the odds table grows. `PAYOUT_RATE` is a config knob (0.3%–0.8% sane range) adjustable from the admin panel.

### 2.7 Ticket lifecycle
- Tickets drop at round start and are **void when the next round drops** — unscratched prizes silently return to the pool. Urgency is a feature. Countdown timer front and center.
- A **"SCRATCH ALL"** button exists for whales (still plays each reveal animation fast-stacked).
- Outcomes are pre-rolled at issuance (provably fair, §4) — scratching only reveals.
- Holdings are re-verified at reveal time: if the wallet dumped below its snapshot tier mid-round, remaining tickets void (kills buy→scratch→sell-within-10-minutes farming).

---

## 3. System Architecture

```
┌────────────┐   WebSocket + REST   ┌──────────────────────────────┐
│  Next.js    │ ◄──────────────────► │  Node/TS backend (Fastify)   │
│  frontend   │                      │  • round engine (cron :10)   │
│  (Vercel or │                      │  • ticket issuance + RNG     │
│   same VPS) │                      │  • payout engine (hot wallet)│
└────────────┘                      │  • fee sweeper               │
                                    │  • price oracle cache        │
                                    └──────┬───────────┬───────────┘
                                           │           │
                                    ┌──────▼─────┐ ┌───▼──────────┐
                                    │ Postgres    │ │ Solana RPC   │
                                    │             │ │ (Helius)     │
                                    └────────────┘ └──────────────┘
Wallets: CREATOR (claims 3% pool fees)  → 70% → PRIZE (hot, holds PUMP, signs payouts)
                                        → 30% → OPS (cold-ish)
```

- **Domain & edge (Cloudflare):** DNS for `scratchyfees.fun` lives in Sammy's Cloudflare account. Frontend at `https://scratchyfees.fun` (+ `www` redirect), API + WebSocket at `https://api.scratchyfees.fun` → the VPS. Proxy both through Cloudflare (orange-cloud): free DDoS protection, TLS, and edge rate-limit rules on `/api/enter` and `/api/scratch` as a first layer in front of the app's own limits. WebSockets pass through Cloudflare's proxy fine. Backend must set CORS to the apex origin only.
- **Stack:** TypeScript monorepo (`pnpm` workspaces): `apps/web` (Next.js), `apps/api` (Fastify), `packages/core` (shared types + the economy math as a pure, heavily-tested module). Deploy API on a VPS/Railway (needs persistent process for cron + websockets + hot wallet); web anywhere.
- **RPC:** Helius (free tier fine to start). All chain reads through it.
- **Price oracle:** two prices needed — $SCRATCHY/USD (for the $50 eligibility tiers) and PUMP/USD (for the ~$ display on prizes and the pool). Derive $SCRATCHY/PUMP straight from the pair's pool reserves, PUMP/USD from Jupiter Price API with DexScreener fallback. Cache 30s. If all sources fail, freeze eligibility at last known price and flag on the site — payouts continue, since they're PUMP-denominated and don't need a price.
- **Fee sweeper (cron, every 5 min):** claim the pool's accrued 3% trading fees via the venue's fee-claim instruction (behind the venue adapter). Fees arrive as both PUMP and $SCRATCHY — swap the $SCRATCHY side to PUMP via Jupiter (slippage-capped) so the pool stays one asset, then transfer 70% → PRIZE wallet, 30% → OPS wallet. Log every sweep with amounts and tx sigs.
- **Live updates:** one WebSocket channel pushes pool balance, jackpot meter, countdown, and winner events to all clients.

### 3.1 Database (Postgres)
```
wallets   (address PK, x_handle NULL, first_seen, total_won_lamports)
rounds    (id PK, starts_at, ends_at, pool_lamports, budget_lamports,
           jackpot_lamports, server_seed_hash, server_seed NULL-until-revealed,
           total_weighted, status)
entries   (round_id, wallet, holdings_usd, tickets, mult, weighted, PK(round_id,wallet))
tickets   (id PK, round_id, wallet, idx, prize_lamports, tier,
           scratched_at NULL, void BOOL, payout_id NULL)
payouts   (id PK, wallet, lamports, tx_sig NULL, status queued|sent|confirmed|failed,
           created_at, confirmed_at)
sweeps    (id, claimed_lamports, to_prize, to_ops, tx_sigs, at)
config    (key, value)   -- PAYOUT_RATE, MIN_POOL_RESERVE, paused flags, etc.
```

### 3.2 API surface
```
POST /api/enter          {wallet, x_handle?}  → verifies holdings, returns entry + tickets for current round
GET  /api/round          → current round, countdown, pool, jackpot, your-tickets-remaining
POST /api/scratch        {ticket_id}          → reveals outcome; if win, enqueues instant payout; returns prize + tx once sent
GET  /api/winners        → recent winners feed (paginated) + all-time biggest
GET  /api/fair/:roundId  → seed hash, revealed seed, verification instructions
GET  /api/stats          → pool history, total paid out, biggest win ever
Admin (token-gated): pause/resume, set PAYOUT_RATE, view breaker events
```
Rate limits: per-IP and per-wallet on `/enter` and `/scratch`. One entry per wallet per round no matter how many browsers paste it (first session gets the scratch UI; others see "this wallet's tickets are being scratched").

---

## 4. Provably Fair RNG (non-negotiable for degen trust)

1. Before each round, generate `serverSeed` (32 random bytes); publish `sha256(serverSeed)` with the round.
2. Ticket outcome: `HMAC_SHA256(serverSeed, `${wallet}:${roundId}:${ticketIdx}`)` → first 8 bytes → uniform float → map through the odds table (and the separate jackpot roll).
3. Reveal `serverSeed` when the round ends. Anyone can recompute every ticket.
4. `/fair` page explains it in one screen with a paste-and-verify widget.

This means outcomes are fixed at issuance — the scratch is pure theater, which is exactly how real scratch tickets work. Own it in the FAQ.

## 5. Payout Engine (fully automatic)

- On a winning scratch: insert `payouts` row → worker sends **PUMP (SPL token transfer)** from the PRIZE wallet immediately, creating the winner's PUMP associated token account idempotently if it doesn't exist (rent paid from the hot wallet's SOL; budget for it). Compute-budget priority fee, retry ×3 with backoff, then mark `failed` for the auto-retry queue. Target: **win → PUMP in wallet in under ~5 seconds**, with the tx signature shown in the win modal (link to Solscan — receipts are hype). The paid amount is the exact PUMP prize; the "~$" shown is informational and allowed to drift with PUMP's price.
- Hot wallet key lives only in server env (`PRIZE_WALLET_KEY`). The sweeper keeps OPS funds out of it; the clamps in §2.5 bound worst-case loss to the pool itself. This is the accepted risk of "fully automatic, everything" — the circuit breaker and Telegram alerts are the tripwires.
- Every payout, sweep, and breaker event logs to Postgres AND a Telegram bot channel (ops visibility from your phone).

## 6. Frontend Spec — the dopamine machine

**Vibe:** lottery-booth-meets-Vegas-meets-Solana. Loud gradients (hot pink / electric purple / gold foil), chunky rounded type, everything glows, nothing is still. Dark background so the foil pops. Mobile-first — most degens scratch on their phone.

### Pages
1. **Home / Play** — hero: live pool counter (odometer-style rolling digits, in PUMP + ~USD), progressive jackpot meter climbing in real time, countdown to next drop, wallet paste box (+ optional X handle), and the ticket tray.
2. **Winners** — live feed (handle-or-truncated-wallet, prize, ticket tier, time, tx link), all-time biggest wins wall.
3. **Fair** — provably-fair verifier.
4. **FAQ** — how it works, why no connect, the 70/30 split, odds table published openly (publishing odds = trust = bullish).

### The scratch ticket (2.5D)
- Card: CSS 3D perspective tilt following pointer/gyroscope, holographic sheen sweep (animated gradient masked by a foil noise texture), rarity-colored frames per tier.
- Scratch layer: `<canvas>` with metallic foil texture; pointer events erase via `globalCompositeOperation='destination-out'` with a soft brush; reveal auto-completes at 60% scratched; particle flakes fall off as you scratch.
- Under the foil: 3 symbols slot-machine style — matching symbols = your prize tier (pre-rolled outcome just drives which symbols render).
- **Win:** screen-shake, confetti cannon (canvas-confetti), gold burst, "🎫 YOU WIN 12,500 PUMP (~$42)" mega-modal with the live tx confirmation, and a **"FLEX ON X"** button → `https://twitter.com/intent/tweet?text=...` prefilled: *"just scratched a 25× on @ScratchyFees and it paid instantly 💸🎫 $SCRATCHY"* + `scratchyfees.fun` link.
- **Jackpot win:** full-screen takeover, siren lights, everyone else on the site sees a global "JACKPOT HIT" banner via websocket.
- Loss reveal still gets a satisfying flip + "next drop in 6:12" nudge, and shows how many more tickets $50 more of $SCRATCHY would earn (the buy-pressure loop).
- **Sound:** scratch loop, tier-escalating win stingers, jackpot fanfare. Placeholder SFX in the repo; Sammy records the real pack (FOH engineer — this should sound *expensive*). Mute toggle persists.

### Libraries
Next.js + Tailwind, framer-motion, canvas-confetti, howler. No heavy 3D engine — the 2.5D approach keeps it 60fps on phones.

### Brand assets (final, in `assets/brand/`)
- `scratchy-mascot-swagger.png` — THE official mascot ("Scratchy"): hot pink serrated ticket, gold sunglasses, flipping a $ coin, $$$ scratched belly, pink high-tops. Use as X pfp, site mascot (hero, win modals, loading states), and coin logo. Derive the site palette from him: hot pink `#FF1493`-ish body, purple `#7B2FBE` rays, gold `#FFC93C`, dark purple background.
- `scratchy-x-banner-1500x500.png` / `scratchy-banner-full-2688x1152.png` — official banner: gold-foil $SCRATCHY wordmark + scratchyfees.fun. Use the full version as the website hero/OG image; keep the site's look consistent with it.
- The build must reuse these exact assets, not regenerate them. Cut transparent-background and head-only crops of the mascot as needed for favicons and win-modal stickers.

## 7. Anti-abuse summary
- Sybil/wallet-splitting: EV linear to $25k by design (§2.1) — splitting earns nothing.
- Same wallet, many tabs: one entry per wallet per round, server-side.
- Buy-scratch-dump inside a round: balance re-check at reveal (§2.7).
- Flash-loan-ish games don't apply (snapshot + re-check are both spot balance, and tickets void on dump).
- Optional config knob (off at launch): require tokens held ≥ 1 full round before first eligibility.
- All RNG server-side, outcomes pre-committed — nothing to manipulate client-side.

## 8. Build Phases (execute in order; each phase ends green)

**Phase 0 — Scaffold.** Monorepo, CI, lint, Postgres via docker-compose, env template, `packages/core` with all §2 formulas as pure functions.
**Phase 1 — Economy core + tests.** Odds table, ticket issuance, multipliers, clamps, jackpot accrual. REQUIRED tests: probabilities sum to 1; EV per ticket = 1.0e ± 1e-9; Monte Carlo (10k rounds at 50/300/1500 tickets) mean round payout = 0.9B ± 2% and never exceeds 3B; 30-day pool sim converges with steady inflow. A `pnpm sim` script prints the sustainability table.
**Phase 2 — Chain layer on devnet.** Wallet holdings reader, dual price oracle w/ fallbacks, SPL payout sender with idempotent ATA creation and retries (use a devnet mock mint standing in for PUMP), fee sweeper behind the venue adapter (mocked claim + swap on devnet), Telegram alerts.
**Phase 3 — Round engine + API.** Cron rounds, entries, provably-fair seeds, scratch endpoint, websocket feed, rate limits.
**Phase 4 — Frontend.** All pages + the full scratch experience per §6. Must feel incredible on a phone.
**Phase 5 — Hardening + dry run.** Circuit breakers, pause switches, admin panel, load test scratch endpoint, then a full **devnet dress rehearsal**: fake fee inflow, 3 test wallets, 24h of accelerated rounds, verify every payout on-chain.
**Phase 6 — Mainnet launch checklist.** Point Cloudflare DNS: apex + `www` → frontend, `api` subdomain → VPS, both proxied, edge rate-limit rules on. Launch $SCRATCHY paired with PUMP at 3% pool fee on the confirmed venue (creator/fee-claim wallet = the sweeper's CREATOR wallet), wire the real PUMP mint + pool address into config, fund the PRIZE wallet's seed (PUMP) + jackpot seed + SOL gas, point config at mainnet, `PAYOUT_RATE` 0.5%, breaker armed, Telegram wired, @ScratchyFees pinned post with the odds table + site link, go.

## 9. Config reference
```
PAYOUT_RATE=0.005          ROUND_SECONDS=600         MIN_HOLD_USD=50
TICKETS_PER_50=5           TICKET_CAP=100            MULT_CAP=25
JACKPOT_SHARE=0.10         JACKPOT_ODDS=50000        SINGLE_PRIZE_CAP=0.05
ROUND_BREAKER=3.0          MIN_POOL_RESERVE_USD=300  FEE_SPLIT_POOL=0.70
POOL_TRADING_FEE=0.03      MIN_GAS_SOL=0.1           SWEEP_INTERVAL_MIN=5
PUMP_MINT=pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn
PRICE_CACHE_SECONDS=30     DOMAIN=scratchyfees.fun
API_ORIGIN=https://api.scratchyfees.fun               X_HANDLE=ScratchyFees
```

## 10. v2 backlog (do NOT build in v1)
Daily MEGA draw among all day's tickets · streak bonus (scratch every round in a row → bonus ticket) · golden cosmetic tickets · holder badges/levels · Telegram bot ("your tickets dropped!") · auto-post jackpots from the project X account · seasonal ticket art drops · referral tickets.

## 11. Straight talk (one paragraph, then we build)
Randomized crypto prizes = this walks and quacks like a lottery/gambling product in many jurisdictions, even though holders never *buy* tickets (it's structured as a holder reward from fees you already earned as creator — materially better than selling chances, but not a legal opinion; worth 30 minutes with someone who knows the space before it's big). And "fully automatic everything" means the hot wallet is the product's single point of failure — the clamps cap the blast radius at the pool, never your personal funds, so keep OPS swept out religiously. Neither point blocks the build.

---
*Prize math verified by Monte Carlo simulation, 2026-09-29. Companion projects: cockfight (70/30 split, paste-wallet pattern), parking.fun (fees-go-somewhere pattern), jito bundler tool (optional for launch).*
