# Mainnet launch checklist (Phase 6)

Everything up to here ran on **devnet**. Nothing in this repo has touched mainnet, and nothing will until you
set `ALLOW_MAINNET=yes`. The steps below are **yours to run**: they involve real keys and real money, so no
AI or other third party should ever see a mainnet key.

Tick the boxes in order. Each `⛔` is a hard stop: don't continue past it until it's resolved.

---

## 0. Blockers and decisions (do these first, days ahead)

- [ ] ⛔ **Meteora token badge for PUMP.** DAMM v2 refuses Token-2022 mints that keep a transfer-hook
      authority, and real PUMP has one (its hook program is unset, but the authority is set). Ask Meteora
      to badge PUMP for DAMM v2. **If they refuse:** the fallback venue is Meteora **DLMM**, where PUMP is
      already badged. The DLMM adapter is **not built yet**. It plugs in behind the same `VenueAdapter`
      interface (`apps/api/src/venue/types.ts`), but it needs building and a devnet rehearsal before launch.
- [ ] **Decide on permanently locking the LP position.** Locking is the trust signal holders expect, and it
      is irreversible: you can never pull that liquidity. The fee claim keeps working either way.
- [ ] **Accounts:** a VPS (Ubuntu 24.04, 2 vCPU / 4 GB is plenty), a Cloudflare account for
      scratchyfees.fun, a **Helius mainnet** RPC key (paid tier recommended), a Telegram bot + ops chat, a
      Vercel account for the site, and optionally a Jupiter API key.
- [ ] Read `docs/ECONOMY.md` → "Flags" once more (jackpot per-ticket sybil note, dust vs ATA rent, the
      breaker at low participation). These are accepted spec behaviours, not bugs.

## 1. Wallets (on your own machine, never on a shared screen)

| Wallet       | Lives where                                          | Holds                                             |
| ------------ | ---------------------------------------------------- | ------------------------------------------------- |
| **PRIZE**    | server env only (hot)                                | the prize pool (PUMP) + SOL for fees/ATA rent     |
| **CREATOR**  | server env only (hot, **dedicated**)                 | owns the LP position NFT, claims fees; no dev bag |
| **OPS**      | cold (hardware wallet); server gets the address only | receives the 30% ops share                        |
| **Deployer** | cold                                                 | mint authority / pool creation, then emptied      |

- [ ] Generate PRIZE and CREATOR with `solana-keygen new` on an offline-ish machine. Store backups offline.
- [ ] Put **no** personal SCRATCHY in CREATOR. The sweeper's bag guard protects it, but the wallet should be clean.

## 2. The $SCRATCHY token

- [ ] Create the mint (6 decimals recommended, like PUMP) with metadata using the **official art**:
      `assets/brand/scratchy-mascot-pfp-400.png` (icon) and `assets/brand/scratchy-banner-full.png`.
- [ ] Revoke **mint** and **freeze** authority after supply is minted. No Token-2022 transfer fee, and no
      permanent delegate.
- [ ] Record `SCRATCHY_MINT`.

## 3. The pool: Meteora DAMM v2, SCRATCHY / PUMP

- [ ] Create a **custom DAMM v2 pool** with:
  - **token A = SCRATCHY, token B = PUMP.** Order matters: "OnlyB" collects fees in _token B_.
  - **base fee 3% flat** (no dynamic fee scheduler)
  - **collect-fee mode = OnlyB** (fees accrue only in PUMP)
  - the position owned by **CREATOR** (the position NFT sits in CREATOR)
  - your chosen initial liquidity / price
- [ ] Lock the position permanently if you decided to (step 0).
- [ ] Record `VENUE_POOL_ADDRESS` and `VENUE_POSITION_ADDRESS`.
- [ ] Boot check: the API **refuses to start** if the pool's fees wouldn't accrue in PUMP only (with `SWAP=none`),
      if the mints don't match, or if CREATOR doesn't hold the position NFT.
- Meteora keeps a protocol share of the fee (20% at the time of writing), so CREATOR receives ~2.4% of volume.
  The devnet run measured exactly 2.43%.

## 4. Fund

- [ ] **PRIZE ← PUMP**: the opening prize pool. At the first round the engine seeds the jackpot with 1%
      of it (J0) and books the balance as the genesis deposit.
      Payouts pause below `MIN_POOL_RESERVE_USD` ($300) worth of PUMP.
- [ ] **PRIZE ← SOL**: ≥ **0.5 SOL** recommended. `MIN_GAS_SOL=0.1` pauses payouts below 0.1 SOL. Each new
      winner's PUMP account costs ~0.002 SOL of rent (Decision D: always paid).
- [ ] **CREATOR ← SOL**: ≥ 0.1 SOL for claim + split transactions (`MIN_CREATOR_GAS_SOL` alerts below 0.05).

## 5. Server (VPS)

```bash
# as root
adduser --system --group scratchy
apt install -y docker.io docker-compose-v2 git
# Node 22 (NodeSource) + pnpm 11 (corepack)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs && corepack enable
git clone <your repo> /opt/scratchy && chown -R scratchy:scratchy /opt/scratchy
cd /opt/scratchy && sudo -u scratchy pnpm install --frozen-lockfile
docker compose up -d db          # Postgres on 127.0.0.1:5433 (change the password in docker-compose.yml first)
```

- [ ] Change the Postgres password in `docker-compose.yml` and in `DATABASE_URL`.
- [ ] `mkdir -p /etc/scratchy && install -m 600 -o root /dev/null /etc/scratchy/api.env` and fill it with the
      **mainnet values** below. Use plain `KEY=value` lines with **no inline `# comments`**: systemd would read
      the comment as part of the value. Database migrations run automatically at boot.
- [ ] `cp deploy/scratchy-api.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now scratchy-api`
- [ ] Cloudflare Tunnel for `api.scratchyfees.fun` → `127.0.0.1:4000` (`deploy/cloudflared.example.yml`).
      No inbound ports are needed on the VPS. Firewall everything but SSH.
- [ ] Nightly Postgres backup (`docker exec … pg_dump`) copied off the box. The ledger is the audit trail.

### Mainnet `/etc/scratchy/api.env` (the values that differ from `.env.example`)

```ini
NODE_ENV=production
DEPLOY_ID=mainnet-1                # shows up in every payout memo — change it if you ever reset the DB
DATABASE_URL=postgres://scratchy:<pw>@127.0.0.1:5433/scratchy
ADMIN_TOKEN=<openssl rand -hex 32>
TRUST_CLOUDFLARE=true              # behind the tunnel

CHAIN_MODE=solana
SOLANA_CLUSTER=mainnet-beta
ALLOW_MAINNET=yes                  # ⛔ the interlock — only now
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key>
PUMP_MINT=pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn
PUMP_PRICE_MINT=pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn
SCRATCHY_MINT=<step 2>
PRIZE_WALLET_KEY=<base58 or JSON array>
PRIZE_WALLET_ADDRESS=<pubkey>
CREATOR_WALLET_KEY=<…>
CREATOR_WALLET_ADDRESS=<pubkey>
OPS_WALLET_ADDRESS=<cold wallet pubkey>

VENUE=damm-v2
VENUE_POOL_ADDRESS=<step 3>
VENUE_POSITION_ADDRESS=<step 3>
SWAP=none                          # OnlyB pool: fees are PUMP already

PRICE_SOURCE=live
JUPITER_API_KEY=<optional>
TELEGRAM_BOT_TOKEN=<…>
TELEGRAM_CHAT_ID=<…>
# economy: keep the §9 defaults (PAYOUT_RATE=0.005, ROUND_SECONDS=600, ROUND_BREAKER=3.0, …)
```

The API refuses to boot on mainnet unless all of these hold: `ALLOW_MAINNET=yes`, `CHAIN_MODE=solana`,
`PRICE_SOURCE=live`, `PUMP_MINT` = `PUMP_PRICE_MINT` = real PUMP, the RPC's genesis hash = mainnet, each key
matches its address, a ≥ 32-char `ADMIN_TOKEN`, and a valid `OPS_WALLET_ADDRESS` distinct from PRIZE/CREATOR.
The `DEV_FORCE_*` rehearsal helpers are also refused on mainnet. If CREATOR or OPS is missing, the API boots but
the fee sweeper stays off and posts a **critical** alert.

## 6. First boot: read the logs

`journalctl -u scratchy-api -f` and check:

- [ ] `scratchy api up` with `cluster: mainnet-beta` and your PRIZE address
- [ ] `prize ledger opened with … raw PUMP (genesis deposit)`
- [ ] **no** `mint_changed` pause. PUMP's transfer-hook program is unset today; if it's ever set, payouts
      pause until you review and resume from the admin panel.
- [ ] `https://api.scratchyfees.fun/health` → `{"ok":true,"cluster":"mainnet-beta","chain":"solana","paused":null}`
- [ ] a Telegram message arrives (e.g. the first round / genesis notices)

## 7. The site (Vercel)

- [ ] Import the repo into Vercel with **root directory `apps/web`** and "include files outside the root
      directory" on (it imports `packages/core`). Vercel detects the pnpm workspace; the build command is `pnpm build`.
- [ ] Environment variables:
      `NEXT_PUBLIC_API_ORIGIN=https://api.scratchyfees.fun` ·
      `NEXT_PUBLIC_WS_URL=wss://api.scratchyfees.fun/ws` ·
      `NEXT_PUBLIC_SITE_URL=https://scratchyfees.fun` ·
      `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta` · `NEXT_PUBLIC_X_HANDLE=ScratchyFees`
- [ ] Cloudflare DNS: `scratchyfees.fun` + `www` → Vercel (**www 301 → apex**), `api` → the tunnel. Proxied.
- [ ] Cloudflare rate-limiting rules as a second layer: `/api/enter` ~30/min/IP, `/api/scratch` ~300/min/IP.
      The API enforces its own limits too.
- [ ] Brand the X account: pfp `assets/brand/scratchy-mascot-pfp-400.png`, header
      `assets/brand/scratchy-x-banner-1500x500.png`.

## 8. Live smoke (small, with your own wallet)

- [ ] Hold ≥ $50 of SCRATCHY in a wallet **you** control. Paste it on the site; wait for a drop (≤ 10 min).
- [ ] Scratch. On a win, open the Solscan link and check the memo `scratchy:mainnet-1:<id>`, the recipient and
      the exact amount.
- [ ] `/fair?round=<id>` verifies all tickets after the round ends.
- [ ] `/admin` (paste `ADMIN_TOKEN`): status RUNNING, PRIZE PUMP/SOL correct, no problem payouts.
- [ ] Make a trade → within `SWEEP_INTERVAL_MIN` the sweep claims the fees and splits them 70/30. Check it in the
      admin panel ("sweeps") and on Solscan.

## 9. Go

- [ ] `PAYOUT_RATE=0.5%` (default), breaker armed (default 3×B, auto-verify, Decision E).
- [ ] Pinned post / announcement.
- [ ] Keep `docs/RUNBOOK.md` open for the first day: it explains every alert and pause and how each one resumes.
