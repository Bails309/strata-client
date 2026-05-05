# Strata backend — unified Debian/Chromium image.
#
# This is THE backend image. It ships with Xvnc + Chromium + a
# managed Chromium policy file baked in so the `web` connection
# protocol works out of the box. RDP/SSH/VNC connections work
# unconditionally (they're handled by the separate guacd container).
# The `vdi` protocol is opted into at compose time via the
# docker-compose.vdi.yml overlay which adds the /var/run/docker.sock
# mount (host-root) and flips STRATA_VDI_ENABLED=true.
#
# Build standalone with:
#   docker build -f backend/Dockerfile -t strata-backend:latest .
#
# Architectural note: unlike rustguac's all-in-one image, Strata runs
# guacd as a separate compose service (see docker-compose.yml ::
# guacd). That's why this Dockerfile lacks rustguac's Stage 1
# (guacd-builder) and the FreeRDP runtime libs. Only the Chromium /
# Xvnc / fonts surface differs from the Alpine variant.
#
# Tradeoffs vs. Alpine:
# - Image size: ~520 MB vs. Alpine's ~85 MB. The bulk is Chromium
#   (~250 MB) and tigervnc-standalone-server (~30 MB). The remaining
#   ~150 MB is glibc + Debian base tooling.
# - CVE surface: Chromium ships ~weekly security releases. The base
#   image tag is `debian:trixie-slim` so security uploads land
#   automatically when CI rebuilds; pin to a digest in production if
#   you need reproducibility.
# - Runtime user: drops to `strata` via gosu. Chromium's
#   `chromium-sandbox` SUID binary is preserved (the chromium-sandbox
#   package keeps the SUID bit intact), so we should NOT pass
#   `--no-sandbox` from a non-root strata user — `web_session::
#   ChromiumLaunchSpec.running_as_root` should be `false` in this image.
# - User must have a real home directory (`-m -d /home/strata`)
#   because Chromium's crashpad handler refuses to start with
#   `$HOME` pointing at a non-existent path. This is exactly
#   rustguac's `useradd -m -d /home/rustguac` choice.

# ── Build stage ────────────────────────────────────────────────────────
FROM rust:1.95-slim-trixie@sha256:715efd1ccdc4a63bd6a6e2f54387fff73f904b70e610d41b4d9d74ff38e13ad3 AS builder

# Build deps. pkg-config + openssl-dev for native sqlx/openssl crates;
# libsasl2-dev + libkrb5-dev because the backend's GSSAPI code links
# against libgssapi_krb5 (Kerberos AD bind path).
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        libsasl2-dev \
        libkrb5-dev \
        ca-certificates \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/Cargo.toml ./
COPY backend/Cargo.lock* ./
COPY VERSION ./
# Dependency-cache layer: dummy main so cargo fetches+builds the
# dependency graph before we COPY in the real source.
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release 2>/dev/null || true
RUN rm -rf src

COPY backend/ .
RUN touch src/main.rs && cargo build --release

# ── Runtime stage ─────────────────────────────────────────────────────
FROM debian:trixie-slim@sha256:e18da95f66066b7c5fa31491b524e83121271eca59a3d140f4906c8d0a090367

# Pull latest security patches before installing runtime deps so Trivy
# doesn't flag CVEs that already have an upstream fix.
#
# Package selection mirrors rustguac's runtime stage minus the guacd
# libraries (Strata's guacd lives in a separate compose service):
#
# - tigervnc-standalone-server: provides /usr/bin/Xvnc — the X server
#   that web_session::xvnc_command_args invokes. The "standalone"
#   variant is the headless one (no client/viewer); the operator
#   reaches the kiosk via guacd's RFB connection, not directly.
# - chromium + chromium-sandbox: the kiosk and its SUID sandbox
#   helper. chromium-sandbox MUST stay SUID root for the non-root
#   strata user to spawn Chromium without --no-sandbox.
# - x11-utils: provides xdpyinfo for the spawn-runtime's secondary
#   "Xvnc up?" probe (TCP connect on :5900+N is primary).
# - krb5-user + libsasl2-modules-gssapi-mit + ldap-utils: AD/LDAP
#   client tooling, parity with the Alpine image.
# - gosu: privilege drop in entrypoint (replaces Alpine's su-exec).
# - ca-certificates: TLS root store.
#
# Chromium pulls fonts-liberation, libnss3, libnspr4, and libdbus-1-3
# as transitive dependencies — they don't need explicit listing.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
        ca-certificates \
        gosu \
        krb5-user \
        libsasl2-modules-gssapi-mit \
        ldap-utils \
        tigervnc-standalone-server \
        chromium \
        chromium-sandbox \
        x11-utils \
        libnss3-tools \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/strata-backend /usr/local/bin/strata-backend

# Managed Chromium policy (rustguac parity E2). Chromium reads every
# *.json under /etc/chromium/policies/managed/ at process startup and
# treats the keys as enterprise policy — values cannot be overridden
# by --user-data-dir or command-line flags, defending against a
# malicious login script that tries to relaunch Chromium with weaker
# settings.
#
# Notable values (matching rustguac literally):
# - PasswordManagerEnabled: true   — required for the Login Data
#                                    autofill writer (services/web_autofill.rs).
# - DeveloperToolsAvailability: 0  — DevTools (CDP) MUST be enabled
#                                    for login scripts; UI access is
#                                    blocked via URLBlocklist below.
# - URLBlocklist                   — blocks chrome:// / file:// /
#                                    javascript: / view-source: so a
#                                    compromised page can't reach
#                                    DevTools UI or local FS.
RUN mkdir -p /etc/chromium/policies/managed
COPY backend/chromium-policies/strata.json /etc/chromium/policies/managed/strata.json
RUN chmod 0644 /etc/chromium/policies/managed/strata.json

RUN mkdir -p /app/config /app/migrations
COPY backend/migrations /app/migrations

# Non-root user. The entrypoint fixes ownership on Docker volumes then
# drops to strata. Chromium's SUID sandbox helper continues to work
# under this user because /usr/lib/chromium/chrome-sandbox is
# world-executable + SUID root (set by the chromium-sandbox package).
#
# `-m -d /home/strata -s /bin/sh` matches rustguac's useradd flags:
# Chromium's crashpad handler requires a real, writable home
# directory at $HOME — without `-m` the process dies with
# `Crashpad: failed to start` and B11 (detect_immediate_chromium_crash)
# would fire on every spawn.
RUN groupadd -r strata && useradd -r -g strata -m -d /home/strata -s /bin/sh strata \
    && chown -R strata:strata /app /home/strata \
    && mkdir -p /var/lib/guacamole/recordings /var/lib/guacamole/drive \
    && chown -R strata:strata /var/lib/guacamole \
    && mkdir -p /var/lib/strata/web-sessions \
    && chown -R strata:strata /var/lib/strata

WORKDIR /app
EXPOSE 8080

# HOME points at the strata user's home so Chromium's crashpad
# handler initialises against a writable path. Same reason rustguac
# sets `ENV HOME=/home/rustguac`.
ENV HOME=/home/strata

COPY backend/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

