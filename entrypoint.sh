#!/bin/sh
# Starts barkd and keeps the wallet's VTXOs alive.
#
# Two jobs in one container on purpose: an Ark wallet that nobody refreshes
# loses its funds when the VTXOs expire, so the daemon and its keeper must
# share a lifetime. If the maintenance loop dies, the container dies with it.
set -e

ARK_SERVER=${ARK_SERVER:-https://ark.second.tech}
ESPLORA=${ESPLORA:-https://mempool.second.tech/api}
MAINTAIN_INTERVAL=${MAINTAIN_INTERVAL:-21600}   # 6h

if [ ! -f "$BARKD_DATADIR/mnemonic" ]; then
    echo "[init] no wallet found, creating one"
    bark --datadir "$BARKD_DATADIR" create --mainnet \
        --ark "$ARK_SERVER" --esplora "$ESPLORA"
else
    echo "[init] existing wallet found"
fi

# bark creates these world-readable; the mnemonic in particular should not be.
chmod 600 "$BARKD_DATADIR/mnemonic" "$BARKD_DATADIR/db.sqlite" 2>/dev/null || true

# A fixed auth secret means the token is known before the container ever runs,
# so it can live in the deployment's environment instead of being fished out
# of the container afterwards. Without it barkd generates a random one.
if [ -n "$BARKD_AUTH_SECRET" ]; then
    barkd --datadir "$BARKD_DATADIR" secret refresh --secret "$BARKD_AUTH_SECRET" -q >/dev/null \
        && echo "[init] auth secret set from environment" \
        || { echo "[init] FAILED to set auth secret"; exit 1; }
fi

# The gateway runs the keeper in-process: `bark maintain` cannot open the
# datadir while barkd holds it, so maintenance goes through barkd's HTTP API.
# If the gateway dies, the wallet stops being refreshed, so the container goes
# down with it rather than quietly holding funds that will expire.
trap 'kill $DAEMON $GATEWAY 2>/dev/null; exit 0' TERM INT

echo "[barkd] starting on $BARKD_BIND_HOST:$BARKD_BIND_PORT (loopback only)"
barkd &
DAEMON=$!

# The gateway proxies to barkd, so barkd has to be answering before it starts
# taking requests.
i=0
while [ $i -lt 60 ]; do
    if curl -sf -o /dev/null "http://127.0.0.1:${BARKD_BIND_PORT}/ping" 2>/dev/null; then
        break
    fi
    i=$((i + 1))
    sleep 1
done
if [ $i -ge 60 ]; then
    echo "[fatal] barkd did not answer on loopback within 60s"
    kill "$DAEMON" 2>/dev/null || true
    exit 1
fi
echo "[barkd] ready"

echo "[gateway] starting on 0.0.0.0:${GATEWAY_PORT}"
(cd /gateway && exec bun run index.ts) &
GATEWAY=$!

# `wait -n` is a bashism and /bin/sh here is dash, so poll the children.
while kill -0 "$DAEMON" 2>/dev/null && kill -0 "$GATEWAY" 2>/dev/null; do
    sleep 5
done

echo "[fatal] a child exited, shutting down"
kill "$DAEMON" "$GATEWAY" 2>/dev/null || true
exit 1
