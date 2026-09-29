# Runbook: operating scratchyfees.fun

The API is **one process** (`scratchy-api` under systemd). Inside it run the round engine, the payout worker, the
fee sweeper, the wallet monitor, the price oracle and the reconciler. The engine and the sweeper take Postgres
advisory locks, so a second copy started by accident can't double-run them. Still, run exactly one: the rate
limiters and the per-wallet session locks are in-process.

Everything important goes to **Postgres (`events` table)** and **Telegram**. The admin panel is at
`https://scratchyfees.fun/admin` (paste `ADMIN_TOKEN`; it stays in that tab only). It shows pauses, balances,
the queue, problem payouts, rounds, sweeps and the event log.

## Everyday commands

```bash
journalctl -u scratchy-api -f                # live logs (pino JSON)
systemctl restart scratchy-api               # safe at any time (see "Restarts")
curl -s https://api.scratchyfees.fun/health  # {"ok":true,…,"paused":null}
```

**Deploying an update:** `cd /opt/scratchy && sudo -u scratchy git pull && sudo -u scratchy pnpm install
--frozen-lockfile && systemctl restart scratchy-api`. Migrations run at boot.

**Restarts are safe mid-round.**

- Every payout attempt is saved (signed bytes + signature) **before** it's sent. On boot the worker resumes it:
  it re-broadcasts identical bytes, or rebuilds only after proving the old one expired (finalized height +
  two absence checks ≥ 10 s apart + a transaction lookup).
- Rounds are clock-aligned, so a restart just continues.
- An interrupted fee claim is never guessed at: it is marked `failed`, and any unattributed PUMP left in
  CREATOR is flagged (`sweep.orphan`).

## Pauses: what stops payouts and how each one resumes

While paused, scratches still reveal and wins **queue**. Nothing is dropped; the queue drains on resume.

| Pause (reason)      | Trigger                                                                   | Resumes                                                               |
| ------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `low_gas`           | PRIZE SOL < `MIN_GAS_SOL` (0.1)                                           | **automatically** once SOL ≥ 0.1 × 1.10 → just send SOL               |
| `low_pool`          | pool P < `MIN_POOL_RESERVE_USD` ($300) of PUMP, or no price ever known    | **automatically** at reserve × 1.10 (fees refill it; or top up)       |
| breaker (per round) | a round's ticket payouts would exceed 3×B                                 | **automatically** at round end if every prize re-derives (Decision E) |
| `breaker_mismatch`  | a revealed prize did **not** match its seed recomputation                 | **manual**: this is the bug the breaker exists to catch               |
| `invariant`         | the PRIZE wallet holds **less** PUMP than the ledger explains, seen twice | **manual**: possible key compromise                                   |
| `mint_changed`      | PUMP's extensions / transfer hook changed                                 | **manual**: resuming accepts the new mint state                       |
| `payouts_stuck`     | one PRIZE payout failed simulation 10× in a row                           | **manual** after fixing the cause                                     |
| `manual`            | you, from the admin panel                                                 | you                                                                   |

Hard (manual) pauses also stop the sweeper's 70% transfer **into** PRIZE, in case PRIZE is compromised. The 30%
OPS leg keeps moving. Every admin action needs a written note, which is recorded in the event log and on Telegram.

## Alerts → what to do

| Alert (event kind)                             | Meaning / action                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monitor.low_gas.paused`                       | Send SOL to PRIZE. Auto-resumes.                                                                                                                                              |
| `monitor.low_pool.paused` / `monitor.no_price` | The pool is below the reserve (or no price yet). Rounds are **skipped** (no tickets) until it refills. Normal at a quiet launch; top up PRIZE with PUMP to speed it up.       |
| `monitor.creator_gas_low`                      | Send SOL to CREATOR (claims + splits need it).                                                                                                                                |
| `breaker.tripped` → `breaker.verified`         | Normal variance at low participation: the round's payouts were held, re-derived and released. No action.                                                                      |
| `pause.breaker_mismatch`                       | **Stop.** A prize didn't re-derive. Don't resume until the round is understood: compare `/fair?round=N` with the DB. Contact the developer.                                   |
| `pause.invariant`                              | **Stop.** PUMP left PRIZE with no matching payout. Assume the key is compromised: see "Key compromise".                                                                       |
| `pause.mint_changed` / `mint.transfer_hook`    | PUMP's token config changed (e.g. a transfer hook was set). Look at the new hook program on Solscan. Resume from the admin panel only if payouts are still safe.              |
| `pause.payouts_stuck`                          | A payout keeps failing simulation. Read its error in the admin panel ("problem payouts"), fix the cause, resume, then retry it.                                               |
| `payout.failed`                                | 4 attempts provably didn't land (congestion). It retries automatically with backoff. No action unless it repeats.                                                             |
| `payout.failed_permanent`                      | Deterministic error (e.g. the recipient's account is frozen). The PUMP stays in the pool; a jackpot goes back into the pot. Retry from the admin panel if the cause is fixed. |
| `payout.rpc_trouble`                           | The RPC has been failing for a while (rate limit/outage). Payouts are delayed, not lost. Check the Helius dashboard; switch `RPC_URL` and restart if needed.                  |
| `payout.ata_recreated`                         | A wallet keeps closing its PUMP account and we keep paying rent (Decision D). If it looks like farming, set `ATA_RECREATE_LIMIT=N`.                                           |
| `sweep.claim_failed` / `sweep.error`           | The fee claim failed; nothing moved. It retries next interval. Check CREATOR SOL and the RPC.                                                                                 |
| `sweep.orphan`                                 | CREATOR holds PUMP that no sweep accounts for (an interrupted claim, or someone sent PUMP). Decide manually: send it to PRIZE/OPS yourself, or leave it.                      |
| `sweep.swap_failed` / `sweep.bag_guard`        | Only if the pool collects SCRATCHY fees (not the launch config). The SCRATCHY stays in CREATOR; the PUMP part still splits.                                                   |
| `sweep.disabled`                               | CREATOR key or OPS address missing, so fees are not being swept.                                                                                                              |
| `invariant.inflow`                             | Unexplained PUMP **into** PRIZE (your top-up, someone's dust). Booked as a deposit; it joins the next pool. Informational.                                                    |
| `engine.error`                                 | The round engine tick failed (usually RPC). It retries every second; a missed boundary is caught up.                                                                          |
| `win.big` / `win.jackpot`                      | Celebrate. 🎉                                                                                                                                                                 |

## Playbooks

**RPC outage / rate limits.** Payouts, rounds and sweeps all retry with backoff. Players see "network busy,
try again" (HTTP 503) instead of errors. If it lasts: put a second provider in `RPC_URL`,
`systemctl restart scratchy-api`.

**Key compromise (PRIZE or CREATOR).**

1. Admin → Pause (note: "key compromise").
2. From a clean machine, move the remaining PUMP + SOL out of the compromised wallet with its key.
3. Generate a new wallet, update `/etc/scratchy/api.env`, fund it, restart.
4. The reconciler's genesis ledger is per DB: if you move to a new PRIZE wallet, also set a new `DEPLOY_ID`
   and start from a fresh database (or ask the developer to book the migration).
5. Resume.

For CREATOR: also transfer the LP position NFT to the new CREATOR, unless the position is locked (the NFT still
moves; the liquidity stays locked).

**Payout throughput.** One payout = one transfer. `PAYOUT_CONCURRENCY` (default 4) controls parallel sends.
With a fast RPC (Helius paid), 8–16 is fine. The load test handled ~1,000 scratch requests/s on a laptop; the
chain is the bottleneck, not the API.

**Changing PAYOUT_RATE.** Admin panel → PAYOUT_RATE (0.3%–0.8%). It applies from the next round, and every round
stores the rate it used, so `/fair` stays verifiable.

**Database.** Back up nightly (`docker exec <db> pg_dump -U scratchy scratchy | gzip > …`) and copy it off the
box. The `payouts`, `payout_attempts`, `prize_ledger` and `events` tables are the audit trail. Never delete rows
from them.

**Resetting on purpose** (e.g. after a botched launch): stop the API, back up, drop the DB, bump `DEPLOY_ID`,
start. The reconciler books the current PRIZE balance as the new genesis deposit.

## Checks you can run any time

- `/fair?round=<id>`: re-derives every ticket of a round from the revealed seed in the browser.
- Solscan: every payout's memo is `scratchy:<DEPLOY_ID>:<payoutId>` and matches a row in the admin panel.
- `pnpm devnet:rehearsal`: the full devnet dress rehearsal. It runs the whole system for a day's worth of
  rounds, then verifies every transfer on-chain.
