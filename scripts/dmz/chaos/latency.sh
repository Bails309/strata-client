#!/usr/bin/env bash
# scripts/dmz/chaos/latency.sh — inject 250ms +/- 50ms of latency on
# the link tunnel and assert that the public surface still responds
# under a generous request timeout (the proxy timeout layer is
# configured at 30s by default, so 250ms must be tolerated).
set -euo pipefail
cd "$(dirname "$0")/../../.."
# shellcheck disable=SC1091
source .env.dmz

TP=${TOXIPROXY_URL:-http://127.0.0.1:8474}
PUB="https://127.0.0.1:${DMZ_PUBLIC_PORT:-8443}"

cleanup() {
    curl -fsS -X DELETE "$TP/proxies/dmz-link/toxics/lat" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[lat] adding 250ms +/- 50ms latency"
curl -fsS -X POST "$TP/proxies/dmz-link/toxics" -H 'Content-Type: application/json' -d '{
    "name": "lat",
    "type": "latency",
    "stream": "downstream",
    "attributes": {"latency": 250, "jitter": 50}
}' > /dev/null

echo "[lat] hitting /api/health 5 times"
for i in $(seq 1 5); do
    CODE=$(curl -kS -o /dev/null -w "%{http_code}" "$PUB/api/health")
    echo "[lat] iter $i → $CODE"
    if [[ "$CODE" != "200" ]]; then
        echo "[lat] FAIL: expected 200, got $CODE"
        exit 1
    fi
done
echo "[lat] OK"
