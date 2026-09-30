#!/usr/bin/env bash
# $SCRATCHY — mainnet API launch on Fly.io. Run in your Mac Terminal AFTER the coin is live on pump.fun:
#   bash ~/Desktop/scratchy/deploy/launch-api.sh
# The Fly app (scratchy-api) and Postgres (scratchy-db, attached) already exist.
# Secrets never touch a file or a chat: they're read with hidden input, or copied server-to-server from cockfight-worker.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=scratchy-api
CF=cockfight-worker
export PATH="/opt/homebrew/bin:$PATH"

read -rp "SCRATCHY mint address (from the pump.fun coin page): " SCRATCHY_MINT
[[ ${#SCRATCHY_MINT} -ge 32 ]] || { echo "that doesn't look like a mint"; exit 1; }

cfget() { fly ssh console -a "$CF" -q -C "printenv $1" 2>/dev/null | tr -d '\r\n'; }
read -rp "Reuse cockfight's Helius key, Telegram bot and hot wallet (= scratchy PRIZE) key? [Y/n] " reuse
if [[ ${reuse:-y} != [nN]* ]]; then
  echo "   copying from $CF (values are not shown)…"
  HELIUS=$(cfget HELIUS_API_KEY); PRIZE_WALLET_KEY=$(cfget HOT_WALLET_KEYPAIR)
  TELEGRAM_BOT_TOKEN=$(cfget TELEGRAM_BOT_TOKEN); TELEGRAM_CHAT_ID=$(cfget TELEGRAM_CHAT_ID)
  [[ -n $HELIUS && -n $PRIZE_WALLET_KEY ]] || { echo "could not read them (is $CF running?) — rerun and answer n"; exit 1; }
  RPC_URL="https://mainnet.helius-rpc.com/?api-key=$HELIUS"
else
  read -rsp "Helius mainnet RPC URL: " RPC_URL; echo
  read -rsp "PRIZE wallet private key (HXvS…): " PRIZE_WALLET_KEY; echo
  read -rsp "Telegram bot token (enter to skip): " TELEGRAM_BOT_TOKEN; echo
  read -rp  "Telegram chat id (enter to skip): " TELEGRAM_CHAT_ID
fi

echo "== ⛔ stopping $CF (it signs from the same hot wallet)"
fly secrets set PAYOUTS_ENABLED=false -a "$CF" --stage >/dev/null
fly scale count 0 -a "$CF" -y

ADMIN_TOKEN=$(openssl rand -hex 32)
args=(ALLOW_MAINNET=yes "SCRATCHY_MINT=$SCRATCHY_MINT" "RPC_URL=$RPC_URL" "PRIZE_WALLET_KEY=$PRIZE_WALLET_KEY" "ADMIN_TOKEN=$ADMIN_TOKEN")
[[ -n ${TELEGRAM_BOT_TOKEN:-} ]] && args+=("TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN")
[[ -n ${TELEGRAM_CHAT_ID:-} ]] && args+=("TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID")
fly secrets set -a "$APP" --stage "${args[@]}" >/dev/null
unset PRIZE_WALLET_KEY RPC_URL HELIUS TELEGRAM_BOT_TOKEN args
echo
echo "   ADMIN_TOKEN — save it in your password manager (unlocks scratchyfees.fun/admin):"
echo "   $ADMIN_TOKEN"
echo

echo "== deploying (one machine only — the PRIZE key must have exactly one signer)"
fly deploy . -a "$APP" --config deploy/fly.api.toml --dockerfile deploy/Dockerfile.api --ha=false
fly certs add api.scratchyfees.fun -a "$APP" >/dev/null 2>&1 || true
sleep 15
echo "== boot log — want: 'scratchy api up', mainnet-beta, 'prize ledger opened'; NOT 'pump.fun venue:' warnings"
fly logs -a "$APP" --no-tail | tail -40
echo
echo "Done. Tell Claude 'api deployed'."
