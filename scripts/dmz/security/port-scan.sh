#!/usr/bin/env bash
# scripts/dmz/security/port-scan.sh — assert the DMZ container exposes
# only the expected three ports (8443 public, 8444 link, 9444 operator)
# and nothing else. Uses nmap against the running compose stack.
#
# Run AFTER `docker compose -f docker-compose.yml -f docker-compose.dmz.yml up -d`.
set -euo pipefail
cd "$(dirname "$0")/../../.."

if ! command -v nmap >/dev/null 2>&1; then
    echo "[port-scan] nmap not installed; install with: apt-get install -y nmap"
    exit 2
fi

CONTAINER=${CONTAINER:-strata-dmz}
TARGET_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \
    "$(docker compose ps -q "$CONTAINER" | head -n1)" | awk '{print $1}')
if [[ -z "$TARGET_IP" ]]; then
    echo "[port-scan] could not resolve $CONTAINER IP"
    exit 1
fi

echo "[port-scan] scanning $TARGET_IP (top 1000 ports + 9444)"
SCAN=$(nmap -Pn -p 1-65535 "$TARGET_IP" -oG -)
echo "$SCAN"

OPEN=$(echo "$SCAN" | awk -F'Ports: ' '/Ports:/ {print $2}' | tr ',' '\n' \
    | awk -F'/' '$2=="open"{print $1}' | sort -n | uniq | tr '\n' ' ')
EXPECTED="8443 8444 9444"

# Compare as sorted whitespace-trimmed strings.
OPEN_T=$(echo "$OPEN" | tr -s ' ' | sed 's/^ *//;s/ *$//')
EXPECTED_T=$(echo "$EXPECTED" | tr -s ' ' | sed 's/^ *//;s/ *$//')

if [[ "$OPEN_T" != "$EXPECTED_T" ]]; then
    echo "[port-scan] FAIL: open=[$OPEN_T] expected=[$EXPECTED_T]"
    exit 1
fi
echo "[port-scan] OK — only the expected ports listen"
