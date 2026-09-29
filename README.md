# $SCRATCHY — scratchyfees.fun

Holder-rewards scratch tickets on Solana, paid in **$PUMP** from the coin's 3% trading fee.
Paste a wallet holding ≥ $50 of $SCRATCHY → tickets drop every 10 minutes → scratch → winners are paid
instantly in PUMP to the holding wallet. Full spec: [PLAN.md](PLAN.md).

> Work in progress — built phase by phase (see `git log`). Full run/launch docs land with the final phase.

## Monorepo

| Path            | What                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| `packages/core` | Pure, isomorphic economy + provably-fair math (PLAN §2, §4). Zero I/O. |
| `apps/api`      | Fastify: round engine, payouts, fee sweeper, websocket feed.           |
| `apps/web`      | Next.js: the scratch experience.                                       |
| `assets/brand`  | Official brand art (untouched). `pnpm brand` derives web crops.        |

## Quick start (local, no keys, no Docker)

```bash
pnpm install
pnpm db:start        # real Postgres from npm (leave running)
pnpm test
```
