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
# access to recordings. Backend never needs to write into this volume.
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

# ── Recording playback access ─────────────────────────────────────────
# guacd writes session recordings into the shared `guac-recordings`
# volume as its in-container `guacd:guacd` user (typically uid/gid
# 100/101) with mode 0640 — group-only read. The backend reads those
# files back when the UI requests historic playback (HistoricalPlayer
# → /api/{admin,user}/recordings/{id}/stream → tokio::fs::File::open).
# Without group membership the open() returns EACCES and the playback
# WebSocket closes immediately, surfacing as "Tunnel error" in the UI.
#
# To match the writer's gid we create a local group with the same
# numeric id (looked up off the recordings directory at runtime, since
# different guacd builds may pick a different system gid) and add
# strata to it as a supplementary group. Mirrors the docker.sock
# pattern above.
RECORDINGS_DIR=/var/lib/guacamole/recordings
if [ -d "$RECORDINGS_DIR" ]; then
    # Find a guacd-written file to read its gid; fall back to the dir's
    # gid if the volume is empty on first boot.
    REC_GID=$(find "$RECORDINGS_DIR" -maxdepth 1 -type f -printf '%g\n' 2>/dev/null | head -n1)
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
fi

exec gosu strata strata-backend "$@"
