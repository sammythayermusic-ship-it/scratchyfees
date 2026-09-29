# $SCRATCHY: scratchyfees.fun

Holder-rewards scratch tickets on Solana, paid in **$PUMP** from the coin's 3% trading fee.
Paste a wallet holding ≥ $50 of $SCRATCHY → tickets drop every 10 minutes → scratch → winners are paid
**instantly** in PUMP, straight to the holding wallet. No wallet connect, nothing to sign. Every ticket is
pre-rolled from a committed seed and can be re-derived by anyone on `/fair`. Full spec: [PLAN.md](PLAN.md).

## Monorepo

| Path            | What                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` | Pure, isomorphic economy + provably-fair math (PLAN §2, §4). Exact integer math, zero I/O.                                                                                                                                 |
| `apps/api`      | Fastify: round engine, exactly-once payouts, fee sweeper, monitor, reconciler, websocket.                                                                                                                                  |
| `apps/web`      | Next.js: the scratch experience, `/winners`, `/fair`, `/faq`, `/admin`.                                                                                                                                                    |
| `assets/brand`  | Official brand art (untouched). `pnpm brand` derives the web crops.                                                                                                                                                        |
| `docs/`         | [REHEARSAL](docs/REHEARSAL.md) · [ECONOMY](docs/ECONOMY.md) · [FAIRNESS](docs/FAIRNESS.md) · [SFX](docs/SFX.md) · [RUNBOOK](docs/RUNBOOK.md) · [LAUNCH-CHECKLIST](docs/LAUNCH-CHECKLIST.md) · [SECURITY](docs/SECURITY.md) |
| `deploy/`       | systemd unit + Cloudflare Tunnel example for the API.                                                                                                                                                                      |

## Run it locally (no keys, no Docker, no chain)

Needs Node 22 and pnpm 11.

```bash
pnpm install
pnpm db:start                      # terminal 1: a real Postgres from npm on 127.0.0.1:5433 (leave running)
cp .env.example .env               # optional; the defaults already run fully in memory
ROUND_SECONDS=60 pnpm dev          # terminal 2: API on :4000 + site on :3000 (60 s rounds for quick play)
```

Open <http://localhost:3000> and paste **any** valid Solana address. In memory mode a dev faucet gives it
deterministic $SCRATCHY holdings. Stay on the page and your tickets drop at the next round boundary. The
in-memory chain settles payouts in about a second.

- The chain is in-process and fresh on every API start, so memory mode also resets the database at boot.
- Admin panel: set `ADMIN_TOKEN=<anything>` in `.env`, restart, open <http://localhost:3000/admin>.

```bash
pnpm test        # core (86) + api (260+) + web tests; api tests use the Postgres from `pnpm db:start`
pnpm lint && pnpm typecheck
pnpm sim         # the §2.6 sustainability table (pool trajectory, prizes by participation, breaker rates…)
pnpm --filter @scratchy/api loadtest   # autocannon on /api/scratch (memory chain)
```

## Devnet (real cluster, real transfers, mock mints)

```bash
pnpm devnet:setup          # keys → SOL → mock SCRATCHY/PUMP mints → real Meteora DAMM v2 pools → .env.devnet
                           #   (add --lean if the faucet only gives 1 SOL; exit 2 = fund the printed address)
pnpm devnet:smoke          # Phase 2 gate: payouts (new/existing ATA, hook mint), real claim → exact 70/30, swap path
pnpm devnet:rehearsal      # Phase 5: 144 accelerated rounds, 3 players, fee inflow, forced jackpot + breaker,
                           #   then every payout verified on-chain → .devnet/rehearsal-report.json
```

Run the API against devnet: `cd apps/api && node --env-file=../../.env.devnet --import tsx src/main.ts`.
Every devnet script checks the RPC's **genesis hash** first and refuses any other cluster. The public devnet
RPC rate-limits hard; a free Helius devnet key in `RPC_URL` makes everything much faster.

## Mainnet

Not touched by anything in this repo. [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) has the exact steps:
the Meteora PUMP badge (a blocker), wallets, token, pool, funding, server, site, smoke, go.
[docs/RUNBOOK.md](docs/RUNBOOK.md) explains every alert and pause.
