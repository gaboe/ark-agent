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

# Keeper loop. `maintain` syncs and refreshes VTXOs that are close to expiry;
# the server charges 0 ppm for those, so running it often costs nothing.
(
    while true; do
        sleep "$MAINTAIN_INTERVAL"
        echo "[maintain] $(date -u +%FT%TZ) starting"
        bark --datadir "$BARKD_DATADIR" maintain -q \
            && echo "[maintain] ok" \
            || echo "[maintain] FAILED (will retry next cycle)"
    done
) &
KEEPER=$!

# If the keeper exits, take the daemon down too rather than silently
# running a wallet nobody is refreshing.
trap 'kill $KEEPER 2>/dev/null; exit 0' TERM INT

echo "[barkd] starting on $BARKD_BIND_HOST:$BARKD_BIND_PORT"
barkd &
DAEMON=$!

# `wait -n` is a bashism and /bin/sh here is dash, so poll both children.
while kill -0 "$KEEPER" 2>/dev/null && kill -0 "$DAEMON" 2>/dev/null; do
    sleep 5
done

echo "[fatal] a child exited, shutting down"
kill "$KEEPER" "$DAEMON" 2>/dev/null || true
exit 1
