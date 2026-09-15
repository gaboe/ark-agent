#!/bin/sh
# Redeploy the agent wallet on Coolify and report what came back up.
#
# The image itself is built by GitHub Actions; this only tells Coolify to pull
# the new one. Never point this at a Dockerfile that compiles — see README.
#
# Needs $COOLIFY_URL and $COOLIFY_TOKEN in the environment.
set -e
APP_UUID=qumjaakttw4qav9pmeupgksu
BARKD_URL=${BARKD_URL:-https://barkd.gaboe.xyz}

[ -n "$COOLIFY_TOKEN" ] || { echo "COOLIFY_TOKEN not set"; exit 1; }

echo "triggering deploy..."
curl -sS --max-time 60 -X POST \
    -H "Authorization: Bearer $COOLIFY_TOKEN" \
    "$COOLIFY_URL/api/v1/deploy?uuid=$APP_UUID"
echo

echo "waiting for $BARKD_URL/ping ..."
i=0
while [ $i -lt 60 ]; do
    if curl -s --max-time 10 "$BARKD_URL/ping" 2>/dev/null | grep -q pong; then
        echo "barkd is up"
        exit 0
    fi
    i=$((i + 1))
    sleep 10
done

echo "barkd did not come up within 10 minutes" >&2
exit 1
