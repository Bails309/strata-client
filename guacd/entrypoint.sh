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

# ── Recordings readability ────────────────────────────────────────────
# Recordings written by guacd land here as `guacd:guacd` (uid/gid 100/101
# inside this container) with mode 0640 — group-only read. The strata
# backend container runs as a different uid/gid and would otherwise hit
# EACCES on `tokio::fs::File::open`, surfacing "Tunnel error" to the UI
# at playback time. The complementary fix lives in `backend/entrypoint.sh`:
# the strata user there is added to a supplementary group sharing this
# gid (101) so group-read on 0640 recordings is sufficient. The umask
# below ensures any new files guacd creates outside `recording.c`'s
# explicit-mode open() also stay group-readable.
umask 0027

# Drop to guacd user and exec guacd
exec su-exec guacd /usr/local/sbin/guacd "$@"
