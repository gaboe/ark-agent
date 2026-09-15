#!/bin/sh
# Alert when the wallet stops maintaining itself.
#
# The container restarts on failure, so "the port answers" proves nothing: a
# crash-loop looks healthy from outside while VTXOs march to expiry. This asks
# the gateway when maintenance last *succeeded* and complains if that is stale.
#
# Run it from cron, e.g. hourly:
#   0 * * * * /Users/you/op/payment-agent/check-health.sh
set -e

GATEWAY_URL=${GATEWAY_URL:-https://pay.gaboe.xyz}

notify() {
    echo "[$(date -u +%FT%TZ)] $1" >&2
    # A terminal that nobody is looking at is not an alert.
    osascript -e "display notification \"$1\" with title \"payment-agent\"" 2>/dev/null || true
}

body=$(curl -sS --max-time 30 "$GATEWAY_URL/health" 2>/dev/null) || {
    notify "gateway unreachable at $GATEWAY_URL"
    exit 1
}

printf '%s' "$body" | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    # An older deployment without /health answers 404 with a plain string;
    # saying so beats "unparseable".
    print(f"unexpected response from /health: {raw[:120]!r}")
    raise SystemExit(2)

if d.get("ok"):
    age = d.get("keeper_age_s")
    print(f"ok, keeper last succeeded {age}s ago")
    raise SystemExit(0)

age = d.get("keeper_age_s")
err = d.get("keeper_last_error")
print(f"keeper stale: last success {age}s ago; last error: {err}")
raise SystemExit(1)
' || {
    notify "keeper is stale — funds may expire. Check: $GATEWAY_URL/health"
    exit 1
}
