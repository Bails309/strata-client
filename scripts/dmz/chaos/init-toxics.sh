#!/usr/bin/env bash
# scripts/dmz/chaos/init-toxics.sh — register the toxiproxy upstream
# that backend dials through. Idempotent.
set -euo pipefail
TP=${TOXIPROXY_URL:-http://127.0.0.1:8474}

# Wait until toxiproxy answers.
for _ in $(seq 1 30); do
    if curl -fsS "$TP/proxies" > /dev/null 2>&1; then break; fi
    sleep 1
done

# Delete any prior definition (idempotent re-runs).
curl -fsS -X DELETE "$TP/proxies/dmz-link" > /dev/null 2>&1 || true

# Create the proxy: backend → toxiproxy:8444 → strata-dmz:8444
curl -fsS -X POST "$TP/proxies" -H 'Content-Type: application/json' -d '{
    "name": "dmz-link",
    "listen": "0.0.0.0:8444",
    "upstream": "strata-dmz:8444",
    "enabled": true
}' > /dev/null

echo "[chaos] dmz-link proxy registered"
