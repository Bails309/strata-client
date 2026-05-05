#!/usr/bin/env bash
# scripts/dmz/load/run.sh — run all k6 profiles against the running
# compose stack. Designed for nightly CI; not the PR gate.
set -euo pipefail
cd "$(dirname "$0")/../../.."

URL=${DMZ_URL:-https://localhost:8443}
WS_URL=${DMZ_WS_URL:-wss://localhost:8443}
OUT=${OUT_DIR:-./load-results}
mkdir -p "$OUT"

run() {
    local name=$1; shift
    echo "[load] $name"
    k6 run --insecure-skip-tls-verify \
        --summary-export="$OUT/$name.json" \
        --out json="$OUT/$name.raw.json" \
        "$@"
}

run api-baseline      scripts/dmz/load/api-baseline.js \
    --env DMZ_URL="$URL"

run websocket-fanout  scripts/dmz/load/websocket-fanout.js \
    --env DMZ_URL="$WS_URL" --env CONCURRENT="${WS_CONCURRENT:-1000}"

echo "[load] results in $OUT"
