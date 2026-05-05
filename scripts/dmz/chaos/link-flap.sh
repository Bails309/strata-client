#!/usr/bin/env bash
# scripts/dmz/chaos/link-flap.sh — disable then re-enable the link
# tunnel and assert the supervisor reconnects within the SLA.
#
# Pre-conditions: docker-compose stack from docker-compose.dmz.yml +
# docker-compose.dmz-chaos.yml is running, init-toxics.sh has been
# run once, and operator credentials are exported (.env.dmz).
set -euo pipefail
cd "$(dirname "$0")/../../.."
# shellcheck disable=SC1091
source .env.dmz

TP=${TOXIPROXY_URL:-http://127.0.0.1:8474}
OP="http://127.0.0.1:${DMZ_OPERATOR_PORT:-9444}"
H="Authorization: Bearer ${STRATA_DMZ_OPERATOR_TOKEN}"

links_up() {
    curl -fsS -H "$H" "$OP/status" 2>/dev/null \
        | grep -oE '"links_up":[0-9]+' | grep -oE '[0-9]+$' || echo 0
}

echo "[flap] baseline links_up=$(links_up)"
if (( $(links_up) < 1 )); then
    echo "[flap] no link up at baseline — abort"
    exit 1
fi

echo "[flap] severing the tunnel"
curl -fsS -X POST "$TP/proxies/dmz-link" -H 'Content-Type: application/json' \
    -d '{"enabled": false}' > /dev/null

# Wait for the operator to observe the disconnect.
for _ in $(seq 1 15); do
    if (( $(links_up) == 0 )); then break; fi
    sleep 1
done
if (( $(links_up) != 0 )); then
    echo "[flap] FAIL: operator never observed the link drop"
    exit 1
fi
echo "[flap] disconnect observed"

echo "[flap] restoring the tunnel"
curl -fsS -X POST "$TP/proxies/dmz-link" -H 'Content-Type: application/json' \
    -d '{"enabled": true}' > /dev/null

# Backoff jitter is up to 30s; allow 45s for reconnect.
DEADLINE=$(( $(date +%s) + 45 ))
while :; do
    if (( $(links_up) >= 1 )); then break; fi
    if (( $(date +%s) > DEADLINE )); then
        echo "[flap] FAIL: link did not reconnect within 45s"
        exit 1
    fi
    sleep 2
done

echo "[flap] OK — link reconnected"
