#!/bin/sh
# Talk to the agent's barkd instance.
#
# The bearer token grants FULL access: it can spend every sat in the wallet.
# It lives in the macOS Keychain, never in this repo and never in shell history.
#
#   security add-generic-password -a "$USER" -s barkd-token -w
#
# Usage:
#   ./wallet.sh balance
#   ./wallet.sh vtxos
#   ./wallet.sh invoice 1000 "coffee"
#   ./wallet.sh send <ark-addr|invoice|user@domain> [amount_sat]
#   ./wallet.sh refresh
#   ./wallet.sh raw GET /api/v1/wallet/ark-info
set -e

BARKD_URL=${BARKD_URL:-https://barkd.gaboe.xyz}
: "${BARKD_TOKEN:=$(security find-generic-password -a "$USER" -s barkd-token -w 2>/dev/null)}"
[ -n "$BARKD_TOKEN" ] || {
    echo "no token: export \$BARKD_TOKEN, or store one with" >&2
    echo "  security add-generic-password -a \"\$USER\" -s barkd-token -w" >&2
    exit 1
}

api() {
    method=$1; path=$2; body=$3
    if [ -n "$body" ]; then
        curl -sS --max-time 120 -X "$method" "$BARKD_URL$path" \
            -H "Authorization: Bearer $BARKD_TOKEN" \
            -H 'Content-Type: application/json' -d "$body"
    else
        curl -sS --max-time 120 -X "$method" "$BARKD_URL$path" \
            -H "Authorization: Bearer $BARKD_TOKEN"
    fi
}

json() { python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin),indent=2))' 2>/dev/null || cat; }

cmd=${1:-balance}
case "$cmd" in
  balance)  api GET  /api/v1/wallet/balance | json ;;
  vtxos)    api GET  /api/v1/wallet/vtxos | json ;;
  history)  api GET  /api/v1/wallet/history | json ;;
  address)  api POST /api/v1/wallet/addresses/next | json ;;
  info)     api GET  /api/v1/wallet/ark-info | json ;;
  sync)     api POST /api/v1/wallet/sync | json ;;
  refresh)  api POST /api/v1/wallet/refresh/all | json ;;
  invoice)
      amt=${2:?usage: ./wallet.sh invoice <sat> [description]}
      desc=$3
      body=$(python3 -c "
import json,sys
d={'amount_sat': int('$amt')}
if '''$desc''': d['description']='''$desc'''
print(json.dumps(d))")
      api POST /api/v1/lightning/receives/invoice "$body" | json ;;
  send)
      dest=${2:?usage: ./wallet.sh send <destination> [amount_sat]}
      amt=$3
      body=$(python3 -c "
import json
d={'destination': '''$dest'''}
if '''$amt''': d['amount_sat']=int('''$amt''')
print(json.dumps(d))")
      api POST /api/v1/wallet/send "$body" | json ;;
  raw)
      api "${2:?method}" "${3:?path}" "$4" | json ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
