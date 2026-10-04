#!/bin/sh
# Render every supported Compose topology, so a broken file, a bad
# overlay merge or a renamed variable fails CI instead of an operator's
# `docker compose up`.
#
# Usage: scripts/ci/validate-compose.sh   (needs docker compose v2)
set -eu
cd "$(dirname "$0")/../.."

# The DMZ files refuse to render without these. They are generated here
# so no placeholder secret is committed; nothing is ever started.
filler=$(printf 'x%.0s' $(seq 1 48))
export STRATA_DMZ_OPERATOR_TOKEN="$filler"
export STRATA_DMZ_LINK_PSKS="current:$filler"
export STRATA_DMZ_LINK_PSK_CURRENT="$filler"
export STRATA_DMZ_EDGE_HMAC_KEY="$filler"
export STRATA_DMZ_EDGE_HMAC_KEYS="$filler"
export STRATA_DMZ_ENDPOINTS="dmz.example.invalid:8444"

# Never let a developer's own .env decide whether this passes.
empty_env=$(mktemp)
trap 'rm -f "$empty_env"' EXIT

covered=""
check() {
    echo "== docker compose $*"
    docker compose --env-file "$empty_env" "$@" config --quiet
    for arg in "$@"; do
        case "$arg" in docker-compose*.yml) covered="$covered $arg" ;; esac
    done
}

check -f docker-compose.yml
check -f docker-compose.yml --profile local-db
check -f docker-compose.yml -f docker-compose.vdi.yml
check -f docker-compose.yml -f docker-compose.ghcr.yml
check -f docker-compose.yml -f docker-compose.dmz.yml
check -f docker-compose.yml -f docker-compose.dmz.yml -f docker-compose.dmz-chaos.yml
check -f docker-compose.yml -f docker-compose.internal.yml
check -f docker-compose.dmz-edge.yml
check -f docker-compose.dmz-only.yml
check -f docker-compose.session-test.yml

# A new compose file must be added above, or it is never validated.
missing=0
for f in docker-compose*.yml; do
    case " $covered " in
        *" $f "*) ;;
        *) echo "ERROR: $f is not validated by $0"; missing=1 ;;
    esac
done
exit "$missing"
