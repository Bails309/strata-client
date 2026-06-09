#!/usr/bin/env bash
# Strata VDI Kali image entrypoint.
#
# Mirrors contrib/vdi-sample/entrypoint.sh — Strata injects
# VDI_USERNAME and VDI_PASSWORD at container start; we materialise the
# local account and hand control to xrdp.
#
# Reserved keys (VDI_USERNAME / VDI_PASSWORD) are stripped from the
# operator-supplied env_vars on the Strata side, so anything reaching
# this script in those slots is the runtime credential, not user
# input.

set -euo pipefail

if [[ -z "${VDI_USERNAME:-}" ]] || [[ -z "${VDI_PASSWORD:-}" ]]; then
    echo "FATAL: VDI_USERNAME and VDI_PASSWORD must both be set." >&2
    exit 1
fi

# Defence in depth: backend already enforces this regex, but a
# malformed value here would break useradd and leak the daemon
# error into the audit log.
if ! [[ "$VDI_USERNAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    echo "FATAL: VDI_USERNAME '$VDI_USERNAME' is not a valid POSIX login name." >&2
    exit 1
fi

if ! id -u "$VDI_USERNAME" >/dev/null 2>&1; then
    # `sudo` group matches the sample image so the operator can grant
    # passwordless root via /etc/sudoers.d/ if their threat model
    # allows it. Default Kali sudoers requires the password, which is
    # the ephemeral one — printed nowhere, never reused.
    useradd --create-home --shell /bin/bash --groups sudo "$VDI_USERNAME"
fi

# chpasswd reads STDIN to avoid leaking the password into the process
# table.
echo "${VDI_USERNAME}:${VDI_PASSWORD}" | chpasswd

# Persistent-home bind mount may land here owned by a different UID
# on the host; reset ownership so XFCE can write its .cache /
# .config. Idempotent — no-op on fresh containers.
chown -R "${VDI_USERNAME}:${VDI_USERNAME}" "/home/${VDI_USERNAME}"

# sesman first (it owns PAM auth + session lifecycle), then xrdp in
# the foreground so signals reach it and the container exits when
# xrdp exits (which is what the Strata reaper waits on).
service dbus start || true
xrdp-sesman --nodaemon &
exec xrdp --nodaemon
