# Security

## What the server holds

| Secret               | Where                                                    | Blast radius if stolen                                                              |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `PRIZE_WALLET_KEY`   | `/etc/scratchy/api.env` (0600)                           | the whole prize pool (it _is_ a hot wallet) + its SOL                               |
| `CREATOR_WALLET_KEY` | same                                                     | unclaimed/unsplit fees + CREATOR SOL; can move the LP position NFT                  |
| `ADMIN_TOKEN`        | same (≥ 32 chars, enforced in production and on mainnet) | pause/resume, PAYOUT_RATE within 0.3–0.8%, retries — **never** moves funds directly |
| OPS                  | **address only**                                         | nothing on the server                                                               |

Players never sign anything and never connect a wallet; prizes go only to the address stored on the ticket.

## Defences in the code

- **Mainnet interlocks** (`apps/api/src/env.ts`): `ALLOW_MAINNET=yes`, `CHAIN_MODE=solana`, `PRICE_SOURCE=live`,
  real PUMP for both mint settings, a strong `ADMIN_TOKEN`; `DEV_FORCE_*` and `SWAP=jupiter` refused. The RPC's
  genesis hash must match the configured cluster; each key must match its configured address; key _files_ load
  on devnet/localnet only.
- **Exactly-once payouts** (`payouts/worker.ts`): attempts persisted before sending, identical-bytes rebroadcast,
  rebuild only after proven expiry, lease-fenced; a second landing hard-stops everything (`invariant`).
- **Reconciler**: an unexplained PUMP _outflow_ from PRIZE (possible key compromise) pauses payouts.
- **Mint watch**: a change to PUMP's Token-2022 extensions / transfer hook pauses payouts until reviewed.
- **Venue boot checks**: pool mints, CREATOR owns the position NFT, fees accrue in PUMP only (with `SWAP=none`).
- **Admin**: routes live in an encapsulated `/api/admin` plugin (auth decided by the router's match, not the raw
  URL), constant-time token compare, a note required on every action, every action audited (events + Telegram).
- **Abuse limits**: per-IP (IPv6 bucketed by /64) and per-(IP, wallet) rate limits on `/api/enter` +
  `/api/scratch`; 3 distinct wallets per IP per round; 240/min per IP on public reads with a 3 s cache on
  `/winners` + `/stats`; 8 websockets per IP; 16 KiB bodies, 100 tickets per scratch; only wallets that hold
  SCRATCHY count as drop entrants.
- **Session lock is advisory**: a pasted wallet proves nothing, so no one can lock the real owner out of their
  own tickets; reveals are serialized on the database rows and always pay the ticket's wallet.
- **No leaks**: RPC/provider errors map to a generic 503 `chain_busy`; alerts redact key-like strings and the bot
  token; logs redact `Authorization`.
- **Web**: no `dangerouslySetInnerHTML`; CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, nosniff,
  referrer policy, HSTS; the admin token lives in per-tab `sessionStorage` only.

## Accepted risks (documented, by design)

- The PRIZE wallet is hot: the whole pool is on the server. Protect the VPS (tunnel, no inbound ports, SSH keys
  only, updates) and watch Telegram.
- Jackpot rolls are per ticket, so splitting a > $1k bag across wallets buys more jackpot rolls (ECONOMY flags).
- ATA rent farming (close your PUMP account after every win so PRIZE re-pays ~0.002 SOL rent) is capped by
  `ATA_RECREATE_LIMIT=2` (default): after two openings, that wallet's wins wait until it reopens its own account.
  Repeat winners who keep their account are never affected.
- Anyone can reveal anyone's tickets if they know the ids (the advisory lock) — it spoils the theatre, never the
  money.
- `/api/enter` needs an RPC read per paste; Cloudflare rate-limit rules are the second layer.

## Reporting

Security issues: DM the project on X (@ScratchyFees) — don't post exploit details publicly. Pause first
(`/admin` → Pause) if funds may be at risk; see `docs/RUNBOOK.md` → "Key compromise".
