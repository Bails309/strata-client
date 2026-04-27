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
chown -R strata:strata /app/config 2>/dev/null || true
chown -R strata:strata /var/lib/guacamole 2>/dev/null || true
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

exec gosu strata strata-backend "$@"
