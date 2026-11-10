#!/usr/bin/env bash
# VPS-only refresh clock. Hits local dashboard on 127.0.0.1 only (no external wake).
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/asset-monitor}"
LOCK="$APP_DIR/logs/refresh-cron.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) {\"skipped\":\"already_running\"}" >>"$APP_DIR/logs/refresh-cron.log"
  exit 0
fi

ENV_FILE="$APP_DIR/.env"
BASE=http://127.0.0.1:3000
LOG_DIR="$APP_DIR/logs"
LOG="$LOG_DIR/refresh-cron.log"
mkdir -p "$LOG_DIR"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${CRON_SECRET:?CRON_SECRET missing}"

now_epoch=$(date +%s)
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CFG=$(mktemp)
chmod 600 "$CFG"
trap 'rm -f "$CFG"' EXIT
printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$CRON_SECRET" >"$CFG"

due() {
  local marker="$1" interval="$2"
  local last=0
  [[ -f "$marker" ]] && last=$(cat "$marker" 2>/dev/null || echo 0)
  if (( now_epoch - last >= interval )); then
    echo "$now_epoch" >"$marker"
    return 0
  fi
  return 1
}

post() {
  local path="$1" key="$2"
  curl -sS --config "$CFG" --connect-timeout 8 --max-time 55 -X POST \
    -H "X-Idempotency-Key: ${key}" \
    "${BASE}${path}" 2>/dev/null || echo '{"ok":false,"error":"curl_failed"}'
}
get() {
  local path="$1"
  curl -sS --config "$CFG" --connect-timeout 8 --max-time 25 \
    "${BASE}${path}" 2>/dev/null || echo '{"ok":false,"error":"curl_failed"}'
}

rpc_body=$(post /api/cron/rpc-refresh "vps-rpc-${now_epoch}")

if due "$LOG_DIR/last-web3" 90; then
  web3_body=$(post /api/cron/web3-refresh "vps-web3-${now_epoch}")
else
  web3_body='{"ok":true,"reason":"not_due"}'
fi

if due "$LOG_DIR/last-fast" 60; then
  snap_body=$(post "/api/cron/refresh?mode=fast" "vps-fast-${now_epoch}")
else
  snap_body='{"ok":true,"reason":"not_due"}'
fi

status_body=$(get /api/status)
eval "$(printf '%s' "$status_body" | python3 -c '
import sys, json
try: j=json.load(sys.stdin)
except Exception: j={}
over=int(j.get("walletsOver5min") or j.get("walletsOver10min") or 0)
oldest=int(j.get("oldestWalletAgeSeconds") if j.get("oldestWalletAgeSeconds") is not None else 99999)
print(f"over5={over}")
print(f"oldest={oldest}")
')"

# Local wallet-batch when stale
wb_body='{"ok":true,"reason":"not_due"}'
FAIL_FILE="$LOG_DIR/wallet-batch-fail-streak"
streak=0
[[ -f "$FAIL_FILE" ]] && streak=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
streak=${streak:-0}
[[ "$streak" =~ ^[0-9]+$ ]] || streak=0
WB_FAIL_THRESHOLD=3
WB_COOLDOWN_SEC=900
if (( streak >= WB_FAIL_THRESHOLD )); then
  fail_mtime=$(stat -c %Y "$FAIL_FILE" 2>/dev/null || echo 0)
  if (( now_epoch - fail_mtime >= WB_COOLDOWN_SEC )); then
    echo "$stamp {\"walletBatch\":\"wallet batch circuit reset after cooldown\",\"prevStreak\":$streak}" >>"$LOG"
    streak=0
    echo 0 >"$FAIL_FILE"
  fi
fi
if (( streak < WB_FAIL_THRESHOLD )) && due "$LOG_DIR/last-wallet-batch" 90; then
  if [[ "$over5" != "0" ]] || [[ "$oldest" -gt 180 ]]; then
    wb_body=$(post "/api/cron/refresh?mode=wallet-batch&walletBudget=3&staleMinutes=3" "vps-wb-${now_epoch}")
    ok=$(printf '%s' "$wb_body" | python3 -c 'import sys,json
try:
 j=json.load(sys.stdin)
 print(1 if (j.get("ok") is True and int(j.get("batchSucceeded") or 0)>0) else 0)
except Exception: print(0)')
    if [[ "$ok" == "1" ]]; then echo 0 >"$FAIL_FILE"; else echo $((streak+1)) >"$FAIL_FILE"; fi
  fi
fi

summary=$(RPC_JSON="$rpc_body" WEB3_JSON="$web3_body" WB_JSON="$wb_body" SNAP_JSON="$snap_body" OLDEST="$oldest" OVER5="$over5" python3 -c '
import json, os
def parse(s):
  try: return json.loads(s or "{}")
  except Exception: return {"ok": False}
rpc, web3, wb, snap = map(parse, [os.environ.get("RPC_JSON"), os.environ.get("WEB3_JSON"), os.environ.get("WB_JSON"), os.environ.get("SNAP_JSON")])
def lane(j):
  if j.get("reason"): return j["reason"]
  if j.get("ok") is True: return "ok"
  err=j.get("error")
  if err: return f"fail:{err}"[:40]
  return "fail"
print(json.dumps({
  "rpc": "ok" if rpc.get("ok") is True else "fail",
  "web3": lane(web3),
  "walletBatch": lane(wb),
  "snapshot": lane(snap),
  "oldest": int(os.environ.get("OLDEST") or 0),
  "over5": int(os.environ.get("OVER5") or 0),
}, separators=(",", ":")))
')
echo "$stamp $summary" >>"$LOG"
tail -n 4000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
