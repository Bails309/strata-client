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

# ── Recordings & drive volume ownership ──────────────────────────────
# The recordings/drive named volumes are initialised by the *backend*
# container on first start, which owns them as uid 996 (`strata`). When
# guacd later drops privileges to its own `guacd` user (uid ~100) via
# `su-exec` below, it loses every Linux capability granted by the
# container runtime (cap_add: DAC_OVERRIDE on the compose service is
# wiped on uid change), so it can no longer write into a directory it
# does not own — open(O_CREAT|O_EXCL) fails with EACCES and guacd logs
# "Creation of recording failed: Exhausted all possible unique suffixes".
#
# Take ownership of the shared volumes while we are still root. The
# backend container keeps `cap_add: DAC_OVERRIDE`, so it can still
# read/delete the files regardless of who owns them now.
for d in /var/lib/guacamole/recordings /var/lib/guacamole/drive; do
    if [ -d "$d" ]; then
        chown guacd:guacd "$d" 2>/dev/null || \
            echo "[entrypoint] WARN: cannot chown $d (volume not writable by root)"
    fi
done

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
