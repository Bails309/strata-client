#!/usr/bin/env bash
# scripts/dmz/load/large-transfer.sh — large uploads and downloads through
# the DMZ link (PERF-02).
#
# Brings up strata-dmz + backend + Postgres + Vault as a separate compose
# project on separate ports, so it can run beside a working stack. Each
# file goes up as an outbound Quick Share and comes back through its
# download link; the hashes must match. While each transfer runs, the
# resident memory of strata-dmz and strata-backend is sampled, so the
# report shows whether memory follows the file size or stays flat.
#
# Also checks that an unauthenticated upload and an oversize upload are
# refused without the whole body being taken in.
#
# Needs bash, docker, curl, openssl and sha256sum. Uses the existing
# strata/backend and strata/dmz images and builds only those missing;
# BACKEND_IMAGE tests another backend image instead.
#
#   scripts/dmz/load/large-transfer.sh
#   SIZES="8M-1K 8M+1K 100M 499M" CONCURRENT=4 KEEP=1 scripts/dmz/load/large-transfer.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
# Git Bash would rewrite /proc paths in arguments meant for containers.
export MSYS_NO_PATHCONV=1

PROJECT=${PROJECT:-strata-dmzperf}
PUBLIC_PORT=${PUBLIC_PORT:-18443}
LINK_PORT=${LINK_PORT:-18444}
OPERATOR_PORT=${OPERATOR_PORT:-19444}
SIZES=${SIZES:-"8M-1K 8M+1K 100M 499M"}
CONCURRENT=${CONCURRENT:-4}
WORK=${WORK:-target/dmzperf}
BASE="https://127.0.0.1:${PUBLIC_PORT}"

mkdir -p "$WORK"
ENV_FILE="$WORK/env"
JAR="$WORK/cookies"
ADMIN_PASSWORD=$(openssl rand -hex 16)
OPERATOR_TOKEN=$(openssl rand -base64 32)
PSK=$(openssl rand -base64 32)
cat > "$ENV_FILE" <<EOF
STRATA_DMZ_OPERATOR_TOKEN=$OPERATOR_TOKEN
STRATA_DMZ_LINK_PSKS=current:$PSK
STRATA_DMZ_LINK_PSK_CURRENT=$PSK
STRATA_DMZ_EDGE_HMAC_KEY=$(openssl rand -base64 32)
DMZ_PUBLIC_PORT=$PUBLIC_PORT
DMZ_LINK_PORT=$LINK_PORT
DMZ_OPERATOR_PORT=$OPERATOR_PORT
DMZ_RUST_LOG=info
DEFAULT_ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF

dc() {
    docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f docker-compose.yml \
        -f docker-compose.dmz.yml -f "$WORK/certs.yml" --profile local-db "$@"
}
c() { curl -sS -k --ssl-no-revoke "$@" | tr -d '\r'; }
log() { echo "[large-transfer] $*"; }
# Git Bash runs the native Windows curl, which has no /dev/null.
NULL=/dev/null
[[ $(uname -s) == MINGW* || $(uname -s) == MSYS* ]] && NULL=NUL

cleanup() {
    docker rm -f "$PROJECT-rss-dmz" "$PROJECT-rss-backend" >/dev/null 2>&1 || true
    if [[ "${KEEP:-0}" == 1 ]]; then
        log "KEEP=1: project $PROJECT left running"
    else
        dc down -v >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK"/*.bin "$ENV_FILE" "$JAR" "$WORK/certs" "$WORK/certs.yml"
}
trap cleanup EXIT

# Fresh link and public certificates for this run; certs/dmz is left alone.
OUT="$PWD/$WORK/certs" ./scripts/dmz/gen-test-certs.sh >/dev/null
# Relative paths in an extra compose file resolve against the repository root.
cat > "$WORK/certs.yml" <<EOF
services:
  strata-dmz:
    volumes: ["./$WORK/certs:/certs:ro"]
  backend:
    image: ${BACKEND_IMAGE:-strata/backend:latest}
    volumes: ["./$WORK/certs:/certs:ro"]
EOF

log "starting project $PROJECT (public :$PUBLIC_PORT)"
dc up -d strata-dmz backend postgres-local >/dev/null

wait_for_link() {
    local deadline=$(( $(date +%s) + 180 )) status
    while :; do
        status=$(c -H "Authorization: Bearer $OPERATOR_TOKEN" "http://127.0.0.1:$OPERATOR_PORT/status" 2>&1 || true)
        [[ $status =~ \"links_up\":[1-9] ]] && break
        (( $(date +%s) < deadline )) || { log "link did not come up"; dc logs backend | tail -40; exit 1; }
        sleep 2
    done
}
wait_for_link

# DATABASE_URL in the environment configures the system at boot, without Vault.
code=$(c -c "$JAR" -o "$NULL" -w '%{http_code}' -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" "$BASE/api/auth/login")
[[ "$code" == 200 ]] || { log "login failed: HTTP $code"; exit 1; }
CSRF=$(awk '$6 == "csrf_token" { print $7 }' "$JAR")
code=$(c -b "$JAR" -o "$NULL" -w '%{http_code}' -X PUT -H "X-CSRF-Token: $CSRF" \
    -H 'Content-Type: application/json' -d '{"mode":"local"}' "$BASE/api/admin/settings/vault")
[[ "$code" == 200 ]] || { log "vault setup failed: HTTP $code"; exit 1; }
dc exec -T postgres-local psql -q -U strata -d strata -c \
    "UPDATE users SET outbound_share_requires_approval = FALSE WHERE username = 'admin'" >/dev/null

# ── Memory sampling ─────────────────────────────────────────────────────
# A busybox in each container's PID namespace reads VmRSS of the strata
# process every 200 ms; the peak over a transfer is what gets reported.
start_sampling() {
    local name
    for name in dmz backend; do
        docker run -d --rm --name "$PROJECT-rss-$name" --pid "container:$PROJECT-$( [[ $name == dmz ]] && echo strata-dmz || echo backend )-1" \
            busybox:1.36 sh -c 'while :; do for p in /proc/[0-9]*; do
                case "$(cat "$p/comm" 2>/dev/null)" in strata-*) sed -n "s/^VmRSS:[^0-9]*\([0-9]*\).*/\1/p" "$p/status";; esac
            done; sleep 0.2; done' >/dev/null
    done
    sleep 1
}
peak_mib() {
    docker logs "$PROJECT-rss-$1" 2>/dev/null | sort -n | tail -1 | awk '{ printf "%.0f", $1 / 1024 }'
}
stop_sampling() {
    PEAK_DMZ=$(peak_mib dmz)
    PEAK_BACKEND=$(peak_mib backend)
    docker rm -f "$PROJECT-rss-dmz" "$PROJECT-rss-backend" >/dev/null
}

bytes_of() { # 8M-1K → 8 MiB minus 1 KiB
    [[ $1 =~ ^([0-9]+)([KM])(([+-])([0-9]+)([KM]))?$ ]] || { log "bad size $1"; exit 1; }
    local -A unit=([K]=1024 [M]=1048576)
    local r=("${BASH_REMATCH[@]}")
    local n=$(( r[1] * ${unit[${r[2]}]:-0} ))
    [[ ${r[3]} ]] && n=$(( n ${r[4]} r[5] * ${unit[${r[6]}]:-0} ))
    echo "$n"
}

make_file() {
    [[ -f "$2" ]] || head -c "$1" /dev/urandom > "$2"
}

upload() { # file → "status seconds" and the response in $WORK/resp-<tag>.json
    c -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'Expect:' \
        -F "file=@$1;type=application/octet-stream" -F "justification=large-transfer test" \
        -o "$WORK/resp-$2.json" -w '%{http_code} %{time_total}\n' "$BASE/api/user/outbound-shares"
}

FAILED=0
RESULTS=()
log "baseline RSS: $(start_sampling; stop_sampling; echo "dmz ${PEAK_DMZ} MiB, backend ${PEAK_BACKEND} MiB")"

for spec in $SIZES; do
    bytes=$(bytes_of "$spec")
    f="$WORK/up-$spec.bin"
    make_file "$bytes" "$f"
    want=$(sha256sum "$f" | cut -d' ' -f1)

    start_sampling
    read -r up_code up_s < <(upload "$f" "$spec")
    url=$(sed -n 's/.*"download_url":"\([^"]*\)".*/\1/p' "$WORK/resp-$spec.json")
    down_code=-; down_s=-; got=-
    if [[ -n "$url" ]]; then
        read -r down_code down_s < <(c -b "$JAR" -o "$WORK/down.bin" -w '%{http_code} %{time_total}\n' "$BASE$url")
        got=$(sha256sum "$WORK/down.bin" | cut -d' ' -f1)
        rm -f "$WORK/down.bin"
    fi
    stop_sampling

    verdict=ok
    [[ "$up_code" == 200 && "$down_code" == 200 && "$got" == "$want" ]] || { verdict=FAIL; FAILED=1; }
    RESULTS+=("$(printf '%-8s %10s B  up %s %6ss  down %s %6ss  hash %-5s  peak RSS dmz %4s MiB  backend %4s MiB' \
        "$spec" "$bytes" "$up_code" "$up_s" "$down_code" "$down_s" \
        "$([[ $got == "$want" ]] && echo same || echo DIFF)" "$PEAK_DMZ" "$PEAK_BACKEND") $verdict")
    log "${RESULTS[-1]}"
    [[ $verdict == ok ]] || { cat "$WORK/resp-$spec.json"; echo; }
    rm -f "$f"
done

if (( CONCURRENT > 1 )); then
    f="$WORK/up-concurrent.bin"
    make_file $(( 100 * 1048576 )) "$f"
    start_sampling
    pids=()
    for i in $(seq "$CONCURRENT"); do
        upload "$f" "c$i" > "$WORK/code-c$i" & pids+=($!)
    done
    wait "${pids[@]}"
    stop_sampling
    codes=$(cat "$WORK"/code-c* | awk '{ print $1 }' | sort | uniq -c | xargs)
    verdict=ok
    [[ "$codes" == "$CONCURRENT 200" ]] || { verdict=FAIL; FAILED=1; }
    RESULTS+=("$(printf '%s x 100M concurrent uploads: %s  peak RSS dmz %4s MiB  backend %4s MiB' \
        "$CONCURRENT" "$codes" "$PEAK_DMZ" "$PEAK_BACKEND") $verdict")
    log "${RESULTS[-1]}"
    rm -f "$f" "$WORK"/code-c*
fi

# ── Refusals ────────────────────────────────────────────────────────────
# Without cookies: refused before the body is read, so curl stops sending.
f="$WORK/refuse.bin"
make_file $(( 100 * 1048576 )) "$f"
read -r code secs sent < <(c -H 'Expect:' -F "file=@$f" -o "$NULL" \
    -w '%{http_code} %{time_total} %{size_upload}\n' "$BASE/api/user/outbound-shares" || true)
verdict=ok
[[ "$code" == 401 || "$code" == 403 ]] && (( sent < 100 * 1048576 )) || { verdict=FAIL; FAILED=1; }
RESULTS+=("$(printf 'unauthenticated 100M upload: HTTP %s after %ss, %s of %s bytes sent' \
    "$code" "$secs" "$sent" $(( 100 * 1048576 ))) $verdict")
log "${RESULTS[-1]}"
rm -f "$f"

# Over the route's 500 MiB limit but under the edge's 512 MiB.
f="$WORK/oversize.bin"
make_file $(( 505 * 1048576 )) "$f"
start_sampling
read -r code secs sent < <(c -b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'Expect:' \
    -F "file=@$f;type=application/octet-stream" -F "justification=oversize" -o "$WORK/resp-oversize.json" \
    -w '%{http_code} %{time_total} %{size_upload}\n' "$BASE/api/user/outbound-shares" || true)
stop_sampling
verdict=ok
[[ "$code" == 413 ]] && (( sent < 505 * 1048576 )) || { verdict=FAIL; FAILED=1; }
RESULTS+=("$(printf 'oversize 505M upload: HTTP %s after %ss, %s of %s bytes sent  peak RSS dmz %4s MiB  backend %4s MiB' \
    "$code" "$secs" "$sent" $(( 505 * 1048576 )) "$PEAK_DMZ" "$PEAK_BACKEND") $verdict")
log "${RESULTS[-1]}"
rm -f "$f"

echo
echo "── Summary ──"
printf '%s\n' "${RESULTS[@]}"
exit "$FAILED"
