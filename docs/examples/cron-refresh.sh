#!/usr/bin/env bash
# Local / VPS refresh helper. Call the dashboard on this same machine.
# Prefer systemd timer (see dashboard-refresh.timer) or crontab.
#
# Required env (EnvironmentFile or export):
#   CRON_SECRET=...
#   DASHBOARD_URL=http://127.0.0.1:3000
#
# Crontab example (every minute):
#   * * * * * /usr/local/bin/dashboard-cron-refresh.sh >>/var/log/dashboard-refresh.log 2>&1
#
set -Eeuo pipefail

: "${CRON_SECRET:?CRON_SECRET is required}"
: "${DASHBOARD_URL:?DASHBOARD_URL is required (use http://127.0.0.1:3000 on the same host)}"

url="${DASHBOARD_URL%/}/api/cron/refresh?mode=auto"

curl -fsS -X POST \
  --connect-timeout 10 --max-time 120 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: cron-$(date +%s)" \
  "$url"
echo
