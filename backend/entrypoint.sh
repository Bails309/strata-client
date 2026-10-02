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
# NB: We deliberately do NOT chown /var/lib/guacamole here. On a
# deployment upgraded from the guacd era that volume still holds
# recordings written as `guacd:guacd` (gid 101). Re-chowning to
# strata:strata would destroy the gid signal the supplementary-group
# block below uses to grant strata read (and, since the Azure-sync
# sweeper landed, write) access to those files.
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
# Upgrade compatibility. Recordings written before guacd was removed
# are owned by its in-container `guacd:guacd` user (typically uid/gid
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
#   3. CREATE — the native engine writes each new recording as strata.
#      The guacd-era directory is still owned by guacd, so without the
#      chown below every recording fails with EACCES at session start.
#
# Strata joins a local group matching each gid the existing files carry
# (different guacd builds picked different system gids) and takes
# ownership of the directory itself, never of the files in it.
RECORDINGS_DIR=/var/lib/guacamole/recordings
if [ -d "$RECORDINGS_DIR" ]; then
    STRATA_GID=$(id -g strata)
    # Read access: join every group older recordings were written under.
    # `%G` is the numeric gid (`%g` prints a name once the group exists).
    for REC_GID in $(find "$RECORDINGS_DIR" -maxdepth 1 -type f -printf '%G\n' 2>/dev/null | sort -u); do
        if [ "$REC_GID" = "0" ] || [ "$REC_GID" = "$STRATA_GID" ]; then
            continue
        fi
        EXISTING_GROUP=$(getent group "$REC_GID" | cut -d: -f1 || true)
        if [ -z "$EXISTING_GROUP" ]; then
            EXISTING_GROUP="guac-recordings-${REC_GID}"
            groupadd -g "$REC_GID" "$EXISTING_GROUP"
        fi
        usermod -aG "$EXISTING_GROUP" strata
        echo "[entrypoint] Added strata to ${EXISTING_GROUP} (gid=${REC_GID}) for recording playback access"
    done

    # Write access: the native engine creates every new recording as
    # strata, and the sweeper unlinks files, so strata must own the
    # directory itself. Not recursive, so older files keep their group.
    chown strata:strata "$RECORDINGS_DIR" 2>/dev/null || true
    chmod u+rwx,g+rwxs "$RECORDINGS_DIR" 2>/dev/null || true
    if ! gosu strata test -w "$RECORDINGS_DIR"; then
        echo "[entrypoint] ERROR: ${RECORDINGS_DIR} is not writable by strata; session recordings will fail" >&2
    fi
fi

exec gosu strata strata-backend "$@"
