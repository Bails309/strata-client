#!/bin/bash
# Strata backend entrypoint (Debian variant — rustguac parity E1).
#
# Differences from the Alpine entrypoint:
# - Uses `gosu` instead of `su-exec` (Debian/Ubuntu standard).
# - Uses bash because Debian's /bin/sh is dash and we want trap support
#   for the Chromium-spawn-runtime cleanup hooks (added when the spawn
#   runtime lands).
set -euo pipefail

# Fix ownership on mount points (needed when volumes were created by
# root). The `|| true` swallows EACCES on read-only mounts.
#
# NB: We deliberately do NOT chown /var/lib/guacamole here. That volume
# is shared with the guacd container, which writes recording files as
# its own `guacd:guacd` (gid 101). Re-chowning to strata:strata would
# (a) race with in-flight guacd writes and (b) destroy the gid signal
# the supplementary-group block below uses to grant strata read
# (and, since the Azure-sync sweeper landed, write) access to
# recordings.
chown -R strata:strata /app/config 2>/dev/null || true
chown -R strata:strata /etc/krb5 2>/dev/null || true

# Web-session ephemeral directory tree. Owned by strata so the backend
# can mkdir per-session subdirs without escalating. Lives outside
# /tmp so it survives `tmpwatch` in long-running deployments.
mkdir -p /var/lib/strata/web-sessions 2>/dev/null || true
chown -R strata:strata /var/lib/strata 2>/dev/null || true

# ── VDI: docker.sock access ──
# When the VDI overlay is applied, /var/run/docker.sock is bind-mounted
# from the host. The socket's owning GID varies per host (e.g. 999 on
# Debian, 998 on Arch, 0 on Docker Desktop's WSL VM). To let the
# unprivileged `strata` user talk to bollard's hyper client, we look up
# the socket's GID at runtime and either add `strata` to an existing
# group with that GID or create a `docker-host` group with that GID
# and add `strata` to it. This keeps the runtime unprivileged on the
# rest of the stack.
if [ -S /var/run/docker.sock ]; then
    SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
    if [ "$SOCK_GID" != "0" ]; then
        EXISTING_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1 || true)
        if [ -z "$EXISTING_GROUP" ]; then
            groupadd -g "$SOCK_GID" docker-host
            EXISTING_GROUP=docker-host
        fi
        usermod -aG "$EXISTING_GROUP" strata
        echo "[entrypoint] Added strata to ${EXISTING_GROUP} (gid=${SOCK_GID}) for docker.sock access"
    else
        # Docker Desktop / rootful daemon: socket is owned by root:root
        # mode 0660. The simplest portable fix is to widen the socket's
        # group bits to allow non-root callers; this only affects the
        # bind-mounted view inside this container, not the host file.
        chmod g+rw /var/run/docker.sock 2>/dev/null || true
        chgrp strata /var/run/docker.sock 2>/dev/null || true
        echo "[entrypoint] docker.sock owned by root:root; granted strata group access on the bind-mount"
    fi
fi

# ── Recording playback + sweeper access ──────────────────────────────
# guacd writes session recordings into the shared `guac-recordings`
# volume as its in-container `guacd:guacd` user (typically uid/gid
# 100/101) with mode 0640 — group-only read. The backend interacts
# with this directory two ways:
#
#   1. READ — historic playback (HistoricalPlayer
#      → /api/{admin,user}/recordings/{id}/stream → tokio::fs::File::open).
#      Without group membership the open() returns EACCES and the playback
#      WebSocket closes immediately, surfacing as "Tunnel error" in the UI.
#
#   2. UNLINK — the Azure-sync sweeper (services::recordings::sync_once)
#      removes each .guac after a successful blob upload and also prunes
#      anything older than recordings_retention_days. Unlinking a file
#      requires write+execute on the *parent directory*, not the file
#      itself — so even with group-read on the .guac the dir must be g+w.
#
# To match the writer's gid we create a local group with the same
# numeric id (looked up off the recordings directory at runtime, since
# different guacd builds may pick a different system gid) and add
# strata to it as a supplementary group. We then widen the directory
# itself to g+w (so unlink works) and set g+s so any file created
# later inherits the gid — keeping the writer/reader group invariant
# stable across container restarts. Mirrors the docker.sock pattern
# above.
RECORDINGS_DIR=/var/lib/guacamole/recordings
if [ -d "$RECORDINGS_DIR" ]; then
    # Find a guacd-written file to read its gid; fall back to the dir's
    # gid if the volume is empty on first boot.
    #
    # NB: `find ... | head -n1` races with SIGPIPE — once `head` closes
    # its stdin after the first line, `find` keeps writing and gets
    # killed with SIGPIPE (exit 141). With `set -euo pipefail` at the
    # top of this script, that 141 propagates and aborts the entire
    # entrypoint *before* `exec gosu strata strata-backend` runs. The
    # symptom is a backend container in a crash loop with empty logs
    # and exit code 141. Disable pipefail just for this pipeline so
    # the (harmless) SIGPIPE on `find` does not kill the script.
    set +o pipefail
    REC_GID=$(find "$RECORDINGS_DIR" -maxdepth 1 -type f -printf '%g\n' 2>/dev/null | head -n1)
    set -o pipefail
    if [ -z "${REC_GID:-}" ]; then
        REC_GID=$(stat -c '%g' "$RECORDINGS_DIR")
    fi
    if [ -n "${REC_GID:-}" ] && [ "$REC_GID" != "0" ]; then
        STRATA_GID=$(id -g strata)
        if [ "$REC_GID" != "$STRATA_GID" ]; then
            EXISTING_GROUP=$(getent group "$REC_GID" | cut -d: -f1 || true)
            if [ -z "$EXISTING_GROUP" ]; then
                groupadd -g "$REC_GID" guac-recordings
                EXISTING_GROUP=guac-recordings
            fi
            usermod -aG "$EXISTING_GROUP" strata
            echo "[entrypoint] Added strata to ${EXISTING_GROUP} (gid=${REC_GID}) for recording playback access"
        fi
    fi

    # Grant the recording group write (for unlink) + setgid (so new
    # files keep the shared gid) on the recordings dir itself. Without
    # g+w the Azure-sync sweeper's tokio::fs::remove_file() returns
    # EACCES and stale .guac files accumulate on disk after being
    # uploaded to Azure. Failures here are non-fatal — the dir may be
    # on a read-only mount, in which case the sweeper has nothing to
    # do anyway and the existing EROFS-aggregating warning kicks in.
    chmod g+ws "$RECORDINGS_DIR" 2>/dev/null || \
        echo "[entrypoint] WARN: could not chmod g+ws on ${RECORDINGS_DIR} (read-only mount?)"
fi

exec gosu strata strata-backend "$@"
