# Devnet provisioning scripts

Scripts that stand up the **devnet** rehearsal environment for $SCRATCHY (PLAN.md §8, Phases 2 and 5).
They create throwaway wallets, mock mints, real Meteora DAMM v2 pools and a ready-to-use `.env.devnet`
for the API. They also generate real 3% trading fees, so the fee sweeper has something to claim.

> **Nothing here can touch mainnet.** Before doing anything else, every script asks the RPC for its
> **genesis hash** and refuses to continue unless it is devnet's
> (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`). An RPC URL is only a claim; the genesis hash is
> what the node actually serves. `LOCALNET=1` additionally admits a local test validator, but only on a
> loopback RPC URL (`localhost` / `127.0.0.1` / `[::1]`), and **never** with the mainnet-beta or testnet
> genesis. The check runs before any key is loaded or created.

| File            | What it does                                                                            |
| --------------- | --------------------------------------------------------------------------------------- |
| `setup.ts`      | Idempotent provisioning: keys → SOL → mints → token balances → pools → `.env.devnet`    |
| `fee-inflow.ts` | "Fake fee inflow": TRADER swaps back and forth, so fees accrue to CREATOR's position    |
| `lib.ts`        | Shared helpers: genesis gate, key store, faucet with backoff, send/confirm, bigint math |

Run them from the repo root (they live in `apps/api` so `@solana/*` and `@meteora-ag/*` resolve):

```bash
pnpm --filter @scratchy/api exec tsx scripts/devnet/setup.ts --dry-run   # keys + SOL budget + plan, sends nothing
pnpm --filter @scratchy/api exec tsx scripts/devnet/setup.ts             # provision (safe to re-run)
pnpm --filter @scratchy/api exec tsx scripts/devnet/fee-inflow.ts --count 10
```

Environment: `RPC_URL` (default `https://api.devnet.solana.com`; a Helius devnet URL is more reliable;
`fee-inflow.ts` falls back to the `RPC_URL` recorded in `.env.devnet`),
`LOCALNET=1` (local validator only), `DEVNET_PRIORITY_MICROLAMPORTS` (default 5000).
RPC URLs are redacted in all output, because providers put API keys in the query string or path.

Exit codes: `0` ok · `1` error or refused cluster · `2` **manual SOL funding needed** (see below).

## SOL budget

`setup.ts` prints this table (with live balances) **before** it spends anything. First run:

| Wallet    | Minimum SOL | Why                                                                                 |
| --------- | ----------: | ----------------------------------------------------------------------------------- |
| PRIZE     |        0.60 | hot wallet: payout tx fees + Token-2022 ATA rent (~0.0021 SOL) for every new winner |
| CREATOR   |    **0.41** | 0.30 operating float (fee claims, 70/30 split) **+ 0.11 one-time setup**, see below |
| TRADER    |        0.30 | fee-inflow swaps (~0.00001 SOL each)                                                |
| OPS       |        0.05 | address only for the API; SOL just makes it a normal, existing account              |
| TEST1–3   |   0.05 each | so the test wallets can sell (the "void on dump" test) or move tokens               |
| **Total** |    **1.51** |                                                                                     |

The one-time setup cost (paid by CREATOR) is an estimate with a 25% margin, rounded up to 0.01 SOL:
3 mints incl. metadata (~0.008), 9 token accounts (~0.019), 2 pools at a conservative 0.03 each
(pool, position, position NFT mint + account, two vaults) and ~20 transaction fees. On re-runs, only the
work still pending is counted. Once setup has finished, CREATOR's target falls back to the 0.30 float.

### Faucet and fallback

The faucet is asked for **one** address only, CREATOR (the funder). Requests are at most 1 SOL each,
with exponential backoff (2, 4, 8, 16, 32 s per chunk). CREATOR then tops up every other wallet with a
single transfer transaction. If the faucet keeps refusing, which is common on the public endpoint, the
script **stops with exit code 2** and prints the exact addresses and amounts (rounded up to 0.01 SOL),
for example:

```
══ MANUAL FUNDING NEEDED (devnet) ══
The devnet faucet refused the airdrop. Open https://faucet.solana.com, choose DEVNET, and send at least:

    CREATOR (pays for all)     7xKX…   1.52 SOL

  or, equivalently, fund each wallet directly:
    CREATOR                    7xKX…   0.41 SOL
    PRIZE                      9aQe…   0.6 SOL
    …
```

Fund the addresses at <https://faucet.solana.com> (devnet; GitHub login raises the limit), then run the
same command again. `--no-airdrop` skips the faucet and prints these instructions straight away.
`--dry-run` also creates or loads the keys and prints the table, so you can pre-fund before the real run.

## What `setup.ts` builds

All mints have 6 decimals, and CREATOR is their mint authority.

- **Keys** in `<repo>/.devnet/keys/<name>.json`: solana-keygen JSON byte arrays, mode 0600, directory
  0700, gitignored (`.devnet/`). They are never overwritten and never printed. Wallets: `creator`,
  `prize`, `ops`, `trader`, `test1..3`. Also `mint-scratchy`, `mint-mpump`, `mint-hook`, `posnft-main`
  and `posnft-second`, so a crashed run can adopt what it already created.
- **mock-SCRATCHY**: classic SPL Token.
- **mock-PUMP**: Token-2022 with `MetadataPointer` + `TokenMetadata` ("Mock PUMP" / `mPUMP`) and
  **no transfer hook**. DAMM v2 accepts it without a Meteora token badge. Prizes on devnet are paid in
  this mint (`PUMP_MINT`), and `PUMP_PRICE_MINT` stays the real PUMP mint for ~$ quotes.
- **HOOK-TEST**: Token-2022 with `TransferHook` (authority = CREATOR, program **unset**), plus
  metadata. This mirrors real PUMP today (Token-2022, hook extension present but no hook program). It
  exercises the hook-aware `transferChecked` payout path. PRIZE receives 10,000,000 of it.
- **Token balances** (one-time; recorded in `state.json` and never re-minted, because they get spent):
  PRIZE 50,000,000 mock-PUMP (`--prize-seed`) · TRADER 20,000,000 mock-SCRATCHY + 5,000,000 mock-PUMP.
- **MAIN pool**: DAMM v2 **custom pool** (`createCustomPool`) with these settings:
  - tokenA = mock-SCRATCHY, tokenB = mock-PUMP
  - flat **3%** base fee (`getFeeTimeSchedulerParams(300, 300, FeeTimeSchedulerLinear, 0, 0)`), no
    dynamic fee
  - `collectFeeMode = OnlyB`: fees accrue **only in PUMP**
  - full range `MIN_SQRT_PRICE..MAX_SQRT_PRICE`, `ActivationType.Timestamp`, activation immediate
  - seeded with 100,000,000 mock-SCRATCHY : 10,000,000 mock-PUMP, which sets the price to
    **0.1 mPUMP per SCRATCHY** (≈ $0.00056 at mock PUMP $0.0056)
  - position NFT held by **CREATOR**, liquidity **permanently locked** in the same transaction
    (`isLockLiquidity`)

  Setup reads the pool back and verifies OnlyB, 300 bps, the lock, token order and NFT ownership.

- **SECOND pool**: a small (1,000,000 : 100,000) pool with **`collectFeeMode = BothToken`**, owned by
  CREATOR and not locked. It exists to exercise the SCRATCHY→PUMP swap step of the sweeper with a real,
  non-zero SCRATCHY fee delta. A DAMM v2 custom-pool address is derived from the **mint pair alone**
  (seeds `"cpool"` + sorted mints), so a second custom pool on the same pair cannot exist. The second
  pool therefore uses `createPool` with a **public static config**. Setup picks the config
  automatically: BothToken, flat fee, full range, no dynamic fee, fee closest to 3%. It pins the choice
  in `state.json` before sending. On 2026-09-29, devnet had 12 such configs, the nearest being 2%
  (`HdqGCsprdhmgqaCXjJzGnKib2SGQvmT9XKYmR7ZjMqmi`) and 4% (`FivzJShpkDj7tdLv6hYSyLcZEAF2FsqNfw8W8mPc8op2`).
  If your RPC does not allow listing program accounts, pass `--second-pool-config <address>`. Use
  `--skip-second-pool` to leave it out.
- **Test wallets**: mock-SCRATCHY worth ≈ **$60 / $600 / $5,000**, computed from the MAIN pool's
  initial price × mock PUMP $0.0056. Each is sized at target **+0.5%, rounded up**: TEST1 ≈ 107,678.57
  ($60.30), TEST2 ≈ 1,076,785.71 ($603), TEST3 ≈ 8,973,214.28 ($5,025). Core floors `H / $50` and
  `H / $1,000`, so an exact $600 would sit on the 60-ticket boundary and fall to 55 tickets on the
  smallest price tick. With the cushion, TEST1 gets 5 tickets (mult 1), TEST2 60 tickets (mult 1),
  and TEST3 100 tickets (cap) with a 5.025× multiplier.
- **`.devnet/state.json`**: every address (wallets, mints, pools, vaults, positions, position NFTs,
  static config), the one-time distributions with signatures, and `DEPLOY_ID`. It holds no secrets.
- **`<repo>/.env.devnet`** (mode 0600, gitignored by `.env.*`): `CHAIN_MODE=solana`,
  `SOLANA_CLUSTER=devnet`, `RPC_URL`, `DEPLOY_ID=devnet-YYYYMMDD`, `PUMP_MINT` (mock),
  `PUMP_PRICE_MINT` (real PUMP), `SCRATCHY_MINT`, `PRIZE_WALLET_KEY/ADDRESS`,
  `CREATOR_WALLET_KEY/ADDRESS` (keys as JSON byte arrays), `OPS_WALLET_ADDRESS` (address only),
  `VENUE=damm-v2`, `VENUE_POOL_ADDRESS`, `VENUE_POSITION_ADDRESS`, `SWAP=none`, `PRICE_SOURCE=mock`,
  `MOCK_PUMP_USD=0.0056`. It also carries extras the API ignores: `HOOK_TEST_MINT`,
  `SECOND_POOL_ADDRESS`, `SECOND_POSITION_ADDRESS`, `SECOND_POOL_CONFIG`, TRADER/TEST addresses.
  The file is checked with the API's own `loadConfig()`. Re-running setup rewrites the managed keys
  and keeps any other variables you added (e.g. Telegram).

Run the API against devnet:

```bash
pnpm --filter @scratchy/api exec node --env-file=../../.env.devnet --import tsx src/main.ts
```

To test the hook-aware payout path, set `PUMP_MINT=<HOOK_TEST_MINT>`. To test the sweeper swap path,
point `VENUE_POOL_ADDRESS` / `VENUE_POSITION_ADDRESS` at the SECOND pool.

## `fee-inflow.ts`

TRADER (and only TRADER: CREATOR's key is never read) swaps against the MAIN pool (and/or the SECOND
pool). It alternates a **buy** (spend `--size` mock-PUMP) and a **sell** of exactly the SCRATCHY that buy
returned. Each swap is `swap2`, ExactIn, with an explicit minimum out from `getQuote` + `--slippage-bps`.
The price stays roughly where it started, and TRADER only loses the fees. CREATOR's pending fees are
printed before and after, via `getUnClaimLpFee`.

```bash
pnpm --filter @scratchy/api exec tsx scripts/devnet/fee-inflow.ts \
  --count 10 --size 100000 --interval 3 --pool main   # main | second | both
pnpm --filter @scratchy/api exec tsx scripts/devnet/fee-inflow.ts --dry-run   # quotes only
```

On the MAIN pool, expect **≈ 2.4% of volume** to accrue to CREATOR: the 3% fee minus Meteora's
protocol share (the pool's `protocolFeePercent`, 20% when this was written). The script prints the
measured rate. With the defaults (5 buys of 100k mPUMP + 5 sells back, ≈ 985k mPUMP ≈ $5,500 of
volume), CREATOR accrues ≈ 23,600 mPUMP (≈ $132). On the SECOND (BothToken) pool, buys accrue fees in **SCRATCHY**. That is the delta the
sweeper's swap step must sell. Ctrl-C stops after the swap in flight and still prints the report. If
TRADER drops below 0.02 SOL, it is topped back up to 0.3 SOL: faucet first, otherwise exit 2 with
instructions.

Claiming the fees and the 70/30 split are the sweeper's job (`VENUE=damm-v2`), not this script's.

## Idempotency and recovery

- Every step checks the chain and `state.json` first. Re-running after a crash, a faucet refusal or an
  expired transaction resumes where it stopped.
- Mints and position NFTs use stored keypairs. If an account exists on-chain but was never recorded
  (crash between send and save), setup verifies it and adopts it instead of creating a duplicate.
- Token distributions are _top-ups to a target_, recorded once. A recorded distribution is never
  repeated, because TEST wallets are meant to spend, and PRIZE pays prizes. Delete its key under
  `distributions` in `state.json` to top it up again.
- `state.json` pins the genesis hash. After a devnet reset, the scripts refuse to run until you move
  the file aside.
- If a key file no longer matches the address recorded in `state.json`, setup refuses to continue.
- `--new-deploy-id` issues a fresh `DEPLOY_ID` (use it after wiping the database, so payout memos never
  collide with an earlier run's transactions).

## LOCALNET

`LOCALNET=1 RPC_URL=http://127.0.0.1:8899` works against `solana-test-validator`. In that case the files
are `.devnet/state.localnet.json` and `.env.localnet`. The validator must have the DAMM v2 program
(`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) cloned from devnet, and the chosen static config too
for the SECOND pool. Otherwise pool creation fails.
