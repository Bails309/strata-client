#!/bin/sh
# ── guacd entrypoint wrapper ───────────────────────────────────────────
# Applies custom DNS resolv.conf from the shared config volume (written
# by the backend when an admin configures DNS servers in the UI), then
# drops to the guacd user and execs guacd.
# ───────────────────────────────────────────────────────────────────────

CUSTOM_RESOLV="/app/config/resolv.conf"

if [ -f "$CUSTOM_RESOLV" ]; then
    echo "[entrypoint] Applying custom DNS from $CUSTOM_RESOLV"
    cp "$CUSTOM_RESOLV" /etc/resolv.conf
    cat /etc/resolv.conf
else
    echo "[entrypoint] No custom DNS config found — using container defaults"
fi

# Drop to guacd user and exec guacd
exec su-exec guacd /usr/local/sbin/guacd "$@"
