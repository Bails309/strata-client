#!/usr/bin/env bash
# Strata VDI sample image entrypoint.
#
# Strata injects VDI_USERNAME and VDI_PASSWORD at container start. We:
#   1. Validate them (refuse to start without both).
#   2. Ensure the local Linux account exists with that password.
#   3. Start xrdp + xrdp-sesman in the foreground.
#
# Reserved keys (VDI_USERNAME / VDI_PASSWORD) are stripped from the
# operator-supplied env_vars on the Strata side, so anything reaching
# this script in those slots is the runtime credential, not user input.

set -euo pipefail

if [[ -z "${VDI_USERNAME:-}" ]] || [[ -z "${VDI_PASSWORD:-}" ]]; then
    echo "FATAL: VDI_USERNAME and VDI_PASSWORD must both be set." >&2
    exit 1
fi

# Username sanity check — refuse anything that wouldn't be a safe
# Linux login name. The Strata backend already enforces a stricter
# regex; this is defence in depth.
if ! [[ "$VDI_USERNAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    echo "FATAL: VDI_USERNAME '$VDI_USERNAME' is not a valid POSIX login name." >&2
    exit 1
fi

if ! id -u "$VDI_USERNAME" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash --groups sudo "$VDI_USERNAME"
fi

# `chpasswd` reads STDIN to avoid leaking the password into the
# process table.
echo "${VDI_USERNAME}:${VDI_PASSWORD}" | chpasswd

# Make sure the persistent-home mount is owned by the runtime user
# even when bind-mounted from the host. (Idempotent.)
chown -R "${VDI_USERNAME}:${VDI_USERNAME}" "/home/${VDI_USERNAME}"

# Start sesman first (it owns PAM auth + session lifecycle), then xrdp
# in the foreground so signals reach it and the container exits when
# xrdp exits.
service dbus start || true
xrdp-sesman --nodaemon &
exec xrdp --nodaemon
