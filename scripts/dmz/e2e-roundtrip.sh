#!/usr/bin/env bash
# scripts/dmz/e2e-roundtrip.sh — boot the DMZ overlay, wait for the
# link to come up, hit a few public endpoints, then tear down.
#
# Exits non-zero if any step fails. Designed to run in CI.
set -euo pipefail

cd "$(dirname "$0")/../.."

ENV_FILE=".env.dmz"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "[e2e] generating ephemeral $ENV_FILE"
    # Both PSK and HMAC are decoded as base64 by both halves; keys
    # generated with `-hex` would only have ~half the entropy after
    # base64-decoding. Use -base64 directly.
    B64_1=$(openssl rand -base64 32)
    B64_2=$(openssl rand -base64 32)
    B64_3=$(openssl rand -base64 32)
    sed -e "s|REPLACE_ME_OPERATOR_32_BYTES_BASE64|${B64_1}|" \
        -e "s|REPLACE_ME_LINK_PSK_32_BYTES_BASE64|${B64_2}|g" \
        -e "s|REPLACE_ME_EDGE_HMAC_32_BYTES_BASE64|${B64_3}|" \
        scripts/dmz/sample.env.dmz > "$ENV_FILE"
fi

echo "[e2e] generating test certs"
./scripts/dmz/gen-test-certs.sh

echo "[e2e] bringing the stack up"
docker compose --env-file "$ENV_FILE" \
    -f docker-compose.yml -f docker-compose.dmz.yml up -d --build

cleanup() {
    echo "[e2e] tearing down"
    docker compose --env-file "$ENV_FILE" \
        -f docker-compose.yml -f docker-compose.dmz.yml \
        logs strata-dmz backend > e2e-dmz.log 2>&1 || true
    docker compose --env-file "$ENV_FILE" \
        -f docker-compose.yml -f docker-compose.dmz.yml down -v
}
trap cleanup EXIT

echo "[e2e] waiting for the DMZ link to report at least one session up"
# shellcheck disable=SC1091
source "$ENV_FILE"
DEADLINE=$(( $(date +%s) + 60 ))
while :; do
    NOW=$(date +%s)
    if (( NOW > DEADLINE )); then
        echo "[e2e] timed out waiting for link"
        exit 1
    fi
    STATUS=$(curl -fsS -H "Authorization: Bearer ${STRATA_DMZ_OPERATOR_TOKEN}" \
        "http://127.0.0.1:${DMZ_OPERATOR_PORT:-9444}/status" 2>/dev/null || true)
    LINKS=$(echo "$STATUS" | grep -oE '"links_up":[0-9]+' | grep -oE '[0-9]+$' || echo 0)
    if (( LINKS >= 1 )); then
        echo "[e2e] link is up: $STATUS"
        break
    fi
    sleep 2
done

echo "[e2e] hitting the public surface"
curl -fkS "https://127.0.0.1:${DMZ_PUBLIC_PORT:-8443}/api/health" \
    -o /dev/null -w "[e2e] /api/health → %{http_code}\n"

echo "[e2e] verifying admin DMZ-links snapshot via the public surface"
# Unauthenticated request should be rejected — the DMZ proxy must
# forward to the internal admin layer which requires auth.
HTTP_CODE=$(curl -kS "https://127.0.0.1:${DMZ_PUBLIC_PORT:-8443}/api/admin/dmz-links" \
    -o /dev/null -w "%{http_code}")
if [[ "$HTTP_CODE" != "401" && "$HTTP_CODE" != "403" ]]; then
    echo "[e2e] expected 401/403 from unauthenticated /api/admin/dmz-links, got $HTTP_CODE"
    exit 1
fi
echo "[e2e] unauth admin → $HTTP_CODE (expected)"

echo "[e2e] OK"
