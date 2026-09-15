#!/bin/sh
# Client for the payment agent.
#
# Talks to the gateway, not to barkd: barkd listens on loopback inside the
# container and its all-powerful token never leaves the host. Each command needs
# a key with sufficient scope — read < invoice < spend.
#
#   security add-generic-password -a "$USER" -s pa-read-key -w
#   security add-generic-password -a "$USER" -s pa-invoice-key -w
#   security add-generic-password -a "$USER" -s pa-spend-key -w
#
# Usage:
#   ./wallet.sh balance | vtxos | history | limits
#   ./wallet.sh address | uri [sat]
#   ./wallet.sh invoice <sat> [description]
#   ./wallet.sh send <destination> <sat> [comment]
#   ./wallet.sh refresh
set -e

GATEWAY_URL=${GATEWAY_URL:-https://pay.gaboe.xyz}

key_for() {
    case "$1" in
        read)    name=pa-read-key ;;
        invoice) name=pa-invoice-key ;;
        spend)   name=pa-spend-key ;;
    esac
    security find-generic-password -a "$USER" -s "$name" -w 2>/dev/null || true
}

api() {
    scope=$1; method=$2; path=$3; body=$4
    key=$(key_for "$scope")
    if [ -z "$key" ]; then
        echo "no $scope key in the Keychain; see the header of this script" >&2
        exit 1
    fi
    # The key goes through a config file on stdin, not the command line: an
    # argument is visible in `ps` to every other user on the machine for as
    # long as the request runs.
    if [ -n "$body" ]; then
        printf 'header = "Authorization: Bearer %s"\n' "$key" | \
            curl -sS --max-time 120 -X "$method" "$GATEWAY_URL$path" \
                --config - -H 'Content-Type: application/json' -d "$body"
    else
        printf 'header = "Authorization: Bearer %s"\n' "$key" | \
            curl -sS --max-time 120 -X "$method" "$GATEWAY_URL$path" --config -
    fi
}

json() { python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin),indent=2))' 2>/dev/null || cat; }

cmd=${1:-balance}
case "$cmd" in
  balance) api read GET /balance | json ;;
  vtxos)   api read GET /vtxos | json ;;
  history) api read GET /history | json ;;
  limits)  api read GET /limits | json ;;
  address) api invoice POST /address | json ;;
  uri)
      # BIP-321: one string carrying every rail. A sender that understands it
      # picks Ark and pays nothing; Lightning to this wallet costs a flat 20 sat.
      amt=$2
      body=$(python3 -c "
import json,sys
d={}
if len(sys.argv) > 1 and sys.argv[1]: d['amount_sat']=int(sys.argv[1])
print(json.dumps(d))" "$amt")
      api invoice POST /bip321 "$body" | json ;;
  invoice)
      amt=${2:?usage: ./wallet.sh invoice <sat> [description]}
      body=$(python3 -c "
import json,sys
d={'amount_sat': int(sys.argv[1])}
if len(sys.argv) > 2 and sys.argv[2]: d['description']=sys.argv[2]
print(json.dumps(d))" "$amt" "$3")
      api invoice POST /invoice "$body" | json ;;
  send)
      dest=${2:?usage: ./wallet.sh send <destination> <sat> [comment]}
      amt=${3:?usage: ./wallet.sh send <destination> <sat> [comment]}
      body=$(python3 -c "
import json,sys
d={'destination': sys.argv[1], 'amount_sat': int(sys.argv[2])}
if len(sys.argv) > 3 and sys.argv[3]: d['comment']=sys.argv[3]
print(json.dumps(d))" "$dest" "$amt" "$4")
      api spend POST /send "$body" | json ;;
  refresh) api spend POST /refresh | json ;;
  ping)    curl -sS --max-time 30 "$GATEWAY_URL/ping"; echo ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
