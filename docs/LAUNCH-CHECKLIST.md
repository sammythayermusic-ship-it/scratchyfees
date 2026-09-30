# Mainnet launch checklist (Phase 6) — pump.fun edition

**Venue decision (2026-09-29):** $SCRATCHY launches on **pump.fun as a Custom Pair quoted in PUMP with a 3% creator
fee**, and pump.fun's **"Share creator rewards"** splits that fee **70% → PRIZE (hot) / 30% → OPS (launch wallet)**
on-chain — the exact setup cockfight runs on. The API's `VENUE=pumpfun` adapter claims the fees permissionlessly
from the PRIZE wallet (`distribute_creator_fees_v2`); the shares land in PRIZE and OPS directly. There is **no
CREATOR key on the server**, no Meteora pool, nothing to lock.

Why not Meteora DAMM v2 (the original plan): real PUMP keeps a Token-2022 transfer-hook authority and Meteora has
not badged PUMP for DAMM v2, so that pool cannot be created. The `damm-v2` adapter stays in the repo for devnet
rehearsals only; the API refuses `VENUE=damm-v2` on mainnet.

Everything up to here ran on **devnet**. Nothing touches mainnet until you set `ALLOW_MAINNET=yes`. The steps below
are **yours to run**: they involve real keys and real money, so no AI or other third party should ever see a
mainnet key. Each `⛔` is a hard stop.

---

## 0. Wallets (reusing the cockfight pair — decided 2026-09-29)

| Role      | Wallet                                         | Lives where                                  | Holds                                        |
| --------- | ---------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| **PRIZE** | `HXvSiWxbvFsV7Y8NLgK5jK537EarX6v3PCns5SQSLGV1` | server env only (hot)                        | the prize pool (PUMP) + SOL for fees/rent    |
| **OPS**   | `Hqwjp8NAc9hyFxN1XUJoMQLotUdQuagwM2EpEMqCSjpF` | your Phantom (cold); server gets the address | the 30% ops share; also **creates the coin** |

- [ ] ⛔ **Turn the cockfight worker off first.** It still holds the PRIZE key with payouts enabled on the cockfight
      test coin (`fly secrets set PAYOUTS_ENABLED=false -a cockfight-worker && fly scale count 0 -a cockfight-worker`).
      Two programs signing from one hot wallet would make scratchy's reconciler see cockfight's transfers as
      unexplained outflows and pause itself. When cockfight launches for real, give it fresh wallets.
- [ ] Put **no** personal SCRATCHY in PRIZE. Keep OPS's key off every server.

## 1. Accounts

- [ ] A **Helius mainnet** RPC key (paid tier recommended — every paste is an RPC read).
- [ ] A Telegram bot + ops chat (BotFather → token; chat id).
- [ ] Somewhere to run the API as one persistent process. **Fly.io** (what cockfight uses — you're already logged
      in): `deploy/fly.api.toml` + `deploy/Dockerfile.api` are ready, see the commands at the top of the toml
      (`fly launch` → `fly postgres create/attach` → `fly secrets set …` → `fly deploy … --ha=false`). **Or** a VPS
      (section 5). Postgres is required either way (Fly Postgres, Supabase's connection string, or docker-compose).
- [ ] The site: Vercel (section 7) — or Netlify like cockfight if you prefer; it's a plain Next.js app.
- [ ] Read `docs/ECONOMY.md` → "Flags" once more (jackpot per-ticket sybil note, dust vs ATA rent, the breaker at
      low participation). These are accepted spec behaviours, not bugs.

## 2. Launch the coin on pump.fun (from the OPS / launch wallet)

- [ ] pump.fun → create coin → **Custom Pair**, quote token **PUMP**, creator fee **3%**. Name `$SCRATCHY`, icon
      `assets/brand/scratchy-mascot-swagger-pfp-400.png`, banner `assets/brand/scratchy-banner-full.png`, website
      `https://scratchyfees.fun`, X `@ScratchyFees`.
- [ ] **Share creator rewards** on the coin page: shareholders **PRIZE 70% / OPS 30%** — exactly these two, nothing
      else. The API refuses to boot if the shares aren't 70/30 to these two wallets.
- [ ] **Decide: revoke the sharing admin or not.** Revoking makes the split immutable (the trust signal; cockfight
      did it) — but it also binds the 70% to the PRIZE hot wallet forever, so a compromised PRIZE could never be
      rotated out of the fee stream. Keeping the admin on OPS (your cold launch wallet) keeps that escape hatch; the
      API logs an info note, not a warning. Recommended: **keep the admin** until the pool is large and the ops
      routine is proven, then revoke. The API only _warns_ if the admin is some third wallet.
- [ ] Record `SCRATCHY_MINT`.
- [ ] Rehearsal option (recommended, cheap): do all of the above first on a **throwaway coin** (like cockfight's
      `HFyp…pump`), run the API against it with $20 of PUMP in PRIZE and `MIN_HOLD_USD=1`, make one trade, watch the
      sweep claim + split, scratch a ticket from your own wallet, verify the payout on Solscan. Then repeat for real.
      pump.fun coins can't be created on devnet with a PUMP quote, so this replaces the devnet dress rehearsal.

## 3. Fund

- [ ] **PRIZE ← PUMP**: the opening prize pool. At the first round the engine seeds the jackpot with 1% of it and
      books the balance as the genesis deposit. Payouts pause below `MIN_POOL_RESERVE_USD` ($30 — the launch setting; the spec said $300) worth of PUMP.
- [ ] **PRIZE ← SOL**: ≥ **0.5 SOL**. `MIN_GAS_SOL=0.1` pauses payouts below 0.1 SOL. Each first-time winner's PUMP
      account costs ~0.002 SOL of rent (always paid), and every fee claim costs a fraction of a cent of SOL.
- [ ] Nothing to fund on OPS beyond what pump.fun needs to create the coin.

## 4. Server env (`/etc/scratchy/api.env` on a VPS; on Fly the public values are in `deploy/fly.api.toml` and the secrets go in `fly secrets set`)

Plain `KEY=value` lines, **no inline `# comments`**. Migrations run automatically at boot.

```ini
NODE_ENV=production
DEPLOY_ID=mainnet-1                # in every payout memo — change it if you ever reset the DB
DATABASE_URL=postgres://scratchy:<pw>@127.0.0.1:5433/scratchy
ADMIN_TOKEN=<openssl rand -hex 32>
TRUST_CLOUDFLARE=true              # behind the Cloudflare tunnel / proxy

CHAIN_MODE=solana
SOLANA_CLUSTER=mainnet-beta
ALLOW_MAINNET=yes                  # ⛔ the interlock — only now
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key>
PUMP_MINT=pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn
PUMP_PRICE_MINT=pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn
SCRATCHY_MINT=<step 2>
PRIZE_WALLET_KEY=<base58 or JSON array — the cockfight hot wallet key>
PRIZE_WALLET_ADDRESS=HXvSiWxbvFsV7Y8NLgK5jK537EarX6v3PCns5SQSLGV1
OPS_WALLET_ADDRESS=Hqwjp8NAc9hyFxN1XUJoMQLotUdQuagwM2EpEMqCSjpF

VENUE=pumpfun
SWAP=none

PRICE_SOURCE=live
JUPITER_API_KEY=<optional>
TELEGRAM_BOT_TOKEN=<…>
TELEGRAM_CHAT_ID=<…>
# economy: keep the §9 defaults (PAYOUT_RATE=0.005, ROUND_SECONDS=600, ROUND_BREAKER=3.0, …)
```

Leave `CREATOR_WALLET_KEY` / `CREATOR_WALLET_ADDRESS` / `VENUE_POOL_ADDRESS` / `VENUE_POSITION_ADDRESS` unset
(the API refuses a CREATOR wallet with `VENUE=pumpfun`).

The API refuses to boot on mainnet unless all of these hold: `ALLOW_MAINNET=yes`, `CHAIN_MODE=solana`,
`PRICE_SOURCE=live`, `PUMP_MINT` = `PUMP_PRICE_MINT` = real PUMP, the RPC's genesis hash = mainnet, the PRIZE key
matches its address, a ≥ 32-char `ADMIN_TOKEN`, a valid `OPS_WALLET_ADDRESS` distinct from PRIZE, `VENUE=pumpfun`
with `SWAP=none`, **and** the pump.fun checks: the coin is quoted in PUMP, its creator is the sharing config, the
shareholders are exactly PRIZE 70 / OPS 30. `DEV_FORCE_*` helpers are refused on mainnet.

## 5. Server (VPS variant)

```bash
# as root
adduser --system --group scratchy
apt install -y docker.io docker-compose-v2 git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs && corepack enable
git clone <your repo> /opt/scratchy && chown -R scratchy:scratchy /opt/scratchy
cd /opt/scratchy && sudo -u scratchy pnpm install --frozen-lockfile
docker compose up -d db          # Postgres on 127.0.0.1:5433 (change the password in docker-compose.yml first)
```

- [ ] Change the Postgres password in `docker-compose.yml` and in `DATABASE_URL`.
- [ ] `mkdir -p /etc/scratchy && install -m 600 -o root /dev/null /etc/scratchy/api.env` → fill with section 4.
- [ ] `cp deploy/scratchy-api.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now scratchy-api`
- [ ] Cloudflare Tunnel for `api.scratchyfees.fun` → `127.0.0.1:4000` (`deploy/cloudflared.example.yml`). No inbound
      ports needed. Firewall everything but SSH.
- [ ] Nightly Postgres backup (`docker exec … pg_dump`) copied off the box. The ledger is the audit trail.

## 6. First boot: read the logs

- [ ] `scratchy api up` with `cluster: mainnet-beta` and the PRIZE address
- [ ] **no** `pump.fun venue:` warning (fee ≠ 3% / a stranger holds the sharing admin) — or fix what it names
- [ ] `prize ledger opened with … raw PUMP (genesis deposit)`
- [ ] **no** `mint_changed` pause. PUMP's transfer-hook program is unset today; if it's ever set, payouts pause until
      you review and resume from the admin panel.
- [ ] `https://api.scratchyfees.fun/health` → `{"ok":true,"cluster":"mainnet-beta","chain":"solana","paused":null}`
- [ ] a Telegram message arrives (e.g. the first round / genesis notices)

## 7. The site

- [ ] Vercel: import the repo with **root directory `apps/web`** and "include files outside the root directory" on
      (it imports `packages/core`); build command `pnpm build`.
- [ ] Environment variables: `NEXT_PUBLIC_API_ORIGIN=https://api.scratchyfees.fun` ·
      `NEXT_PUBLIC_WS_URL=wss://api.scratchyfees.fun/ws` · `NEXT_PUBLIC_SITE_URL=https://scratchyfees.fun` ·
      `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta` · `NEXT_PUBLIC_X_HANDLE=ScratchyFees`
- [ ] Cloudflare DNS (zone already on your account, currently empty): `scratchyfees.fun` + `www` → the site
      (**www 301 → apex**), `api` → the Fly app (`fly certs add api.scratchyfees.fun`, CNAME to `scratchy-api.fly.dev`)
      or the VPS tunnel. Proxied.
- [ ] Cloudflare rate-limiting rules as a second layer: `/api/enter` ~30/min/IP, `/api/scratch` ~300/min/IP.
- [ ] Brand the X account: pfp `assets/brand/scratchy-mascot-swagger-pfp-400.png`, header
      `assets/brand/scratchy-x-banner-1500x500.png`.

## 8. Live smoke (small, with your own wallet)

- [ ] Hold ≥ $50 of SCRATCHY in a wallet **you** control. Paste it on the site; wait for a drop (≤ 10 min).
- [ ] Scratch. On a win, open the Solscan link and check the memo `scratchy:mainnet-1:<id>`, the recipient and
      the exact amount.
- [ ] `/fair?round=<id>` verifies all tickets after the round ends.
- [ ] `/admin` (paste `ADMIN_TOKEN`): status RUNNING, PRIZE PUMP/SOL correct, no problem payouts.
- [ ] Make a trade → within `SWEEP_INTERVAL_MIN` (5) the sweep claims the creator vault: the admin panel's
      "sweeps" shows one row `done` with 70/30, and on Solscan the claim tx pays PRIZE and OPS directly.

## 9. Go

- [ ] `PAYOUT_RATE=0.5%` (default), breaker armed (default 3×B, auto-verify).
- [ ] Pinned post / announcement with the odds table + site link.
- [ ] Keep `docs/RUNBOOK.md` open for the first day: it explains every alert and pause and how each one resumes.
