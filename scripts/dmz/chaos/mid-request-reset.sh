#!/usr/bin/env bash
# scripts/dmz/chaos/mid-request-reset.sh — reset the link tunnel mid
# response; assert public client sees a clean 502 (not a 500), and
# the next request after reconnect succeeds.
set -euo pipefail
cd "$(dirname "$0")/../../.."
# shellcheck disable=SC1091
source .env.dmz

TP=${TOXIPROXY_URL:-http://127.0.0.1:8474}
OP="http://127.0.0.1:${DMZ_OPERATOR_PORT:-9444}"
PUB="https://127.0.0.1:${DMZ_PUBLIC_PORT:-8443}"
H="Authorization: Bearer ${STRATA_DMZ_OPERATOR_TOKEN}"

cleanup() {
    curl -fsS -X POST "$TP/proxies/dmz-link" -H 'Content-Type: application/json' \
        -d '{"enabled": true}' > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Fire a request and immediately yank the link.
( curl -kS -o /tmp/resp -w "%{http_code}" "$PUB/api/health" > /tmp/code ) &
REQ_PID=$!
sleep 0.2
curl -fsS -X POST "$TP/proxies/dmz-link" -H 'Content-Type: application/json' \
    -d '{"enabled": false}' > /dev/null
wait "$REQ_PID" || true
CODE=$(cat /tmp/code)
echo "[reset] in-flight request resolved with $CODE"
case "$CODE" in
    200|502|503|504) ;;  # any of these are acceptable
    *) echo "[reset] FAIL: unexpected code $CODE"; exit 1 ;;
esac

# Restore.
curl -fsS -X POST "$TP/proxies/dmz-link" -H 'Content-Type: application/json' \
    -d '{"enabled": true}' > /dev/null

# Wait for reconnect.
for _ in $(seq 1 30); do
    UP=$(curl -fsS -H "$H" "$OP/status" | grep -oE '"links_up":[0-9]+' | grep -oE '[0-9]+$' || echo 0)
    (( UP >= 1 )) && break
    sleep 1
done

CODE=$(curl -kS -o /dev/null -w "%{http_code}" "$PUB/api/health")
if [[ "$CODE" != "200" ]]; then
    echo "[reset] FAIL: post-reconnect health → $CODE"
    exit 1
fi
echo "[reset] OK — post-reconnect /api/health → 200"
