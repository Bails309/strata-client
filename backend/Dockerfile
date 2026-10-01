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
FROM rust:1.98-slim-trixie@sha256:bce1476d4be4d78b83705bc5f428b86d640eeeea33e9dadafbc037b5703a53bf AS builder

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
        cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The backend is a member of a Cargo workspace rooted at the repo
# root and depends on the in-tree `strata-protocol` and `strata-dmz`
# crates under `crates/`. Copy the workspace manifests + per-crate
# Cargo.toml stubs first so the dependency graph can be fetched and
# compiled before the real sources land — that's what gives us the
# layer-cache win on incremental rebuilds.
COPY Cargo.toml Cargo.lock ./
COPY VERSION ./
COPY backend/Cargo.toml backend/Cargo.toml
COPY backend/build.rs backend/build.rs
COPY crates/strata-protocol/Cargo.toml crates/strata-protocol/Cargo.toml
COPY crates/strata-dmz/Cargo.toml crates/strata-dmz/Cargo.toml
COPY crates/strata-session/Cargo.toml crates/strata-session/Cargo.toml
# The [patch.crates-io] forks are third-party code, so they belong in the
# dependency layer; without them the stub build cannot resolve at all.
COPY crates/vendor/ crates/vendor/
# Dependency-cache layer: stub each crate so cargo fetches+builds the
# dependency graph before we COPY in the real source. Must not mask
# errors, or a broken stub silently turns every build into a cold one.
RUN mkdir -p backend/src crates/strata-protocol/src crates/strata-dmz/src crates/strata-session/src \
    && echo "fn main() {}" > backend/src/main.rs \
    && : > crates/strata-protocol/src/lib.rs \
    && echo "fn main() {}" > crates/strata-dmz/src/main.rs \
    && : > crates/strata-session/src/lib.rs \
    && cargo build --release --locked -p strata-backend
RUN rm -rf backend/src crates/strata-protocol/src crates/strata-dmz/src crates/strata-session/src

COPY backend/ backend/
COPY crates/ crates/
# Touching the entrypoint files forces cargo to re-evaluate them
# rather than re-using the stubbed compile artefacts.
RUN touch backend/src/main.rs crates/strata-protocol/src/lib.rs crates/strata-dmz/src/main.rs \
        crates/strata-session/src/lib.rs \
    && cargo build --release --locked -p strata-backend

# ── guacenc builder stage ─────────────────────────────────────────────
# Compiles Apache Guacamole's `guacenc` utility from source, pinned to
# the same guacamole-server commit as `guacd/Dockerfile` so that .guac
# recordings written by our patched guacd are readable by the same
# instruction stream parser. `guacenc` renders a raw .guac session
# recording into an H.264 .m4v/.mp4 video file — this is what the
# `/api/{admin,user}/recordings/:id/download?format=mp4` endpoints in
# `backend/src/services/recordings.rs::convert_guac_to_mp4` invoke.
#
# We deliberately do NOT install any protocol client dev libraries
# (libfreerdp-dev, libssh2-dev, libvncserver-dev, libwebsockets-dev,
# libtelnet-dev, libpulse-dev). guacamole-server's ./configure will
# auto-skip building each libguac-client-*.so when its -dev package is
# absent, and guacenc itself only needs libguac + the image/video libs
# below. The guacd/patches are RDP-only and don't touch guacenc, so
# they're intentionally not applied here.
FROM debian:trixie-slim@sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b AS guacenc-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        autoconf automake libtool pkg-config \
        gcc g++ make git ca-certificates \
        libcairo2-dev libjpeg-dev libpng-dev \
        libossp-uuid-dev libwebp-dev \
        libpango1.0-dev libvorbis-dev \
        libavcodec-dev libavformat-dev libavutil-dev libswscale-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/apache/guacamole-server.git /src \
    && cd /src && git checkout be83001bda2e60f1356604c91144628e8150afeb

WORKDIR /src
# The ENABLE_WEBP assertion is not cosmetic: WebP support is auto-detected
# from libwebp-dev, and guacenc treats a missing decoder as success. Lose
# it and every WebP damage rectangle is silently dropped from exported
# MP4s rather than raising an error.
RUN autoreconf -fi \
    && ./configure --prefix=/usr/local --enable-guacenc \
    && make -j"$(nproc)" \
    && make DESTDIR=/build install \
    && test -x /build/usr/local/bin/guacenc \
    && test -f /build/usr/local/lib/libguac.so \
    && grep -q '^#define ENABLE_WEBP' config.h

# ── Runtime stage ─────────────────────────────────────────────────────
FROM debian:trixie-slim@sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b

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
# - ffmpeg: provides libavcodec/libavformat/libswscale used at runtime
#   by `guacenc` (the H.264 muxer path in convert_guac_to_mp4). Also
#   used directly by the tier-2 frame-extraction fallback in
#   `services/recordings.rs`.
# - libcairo2 / libpango-1.0-0 / libpangocairo-1.0-0 / libjpeg62-turbo /
#   libpng16-16 / libwebp7 / libossp-uuid16 / libvorbisenc2 /
#   libvorbis0a: runtime shared libs required by `guacenc` for image
#   decoding and the .m4v/.mp4 encoder pipeline. The `guacenc` binary
#   and `libguac.so*` themselves are copied in from the guacenc-builder
#   stage below (Debian's own guacamole-server package is 1.5.5; we
#   build against 1.6.1 to stay wire-compatible with our patched guacd).
#
# Chromium pulls fonts-liberation, libnss3, libnspr4, and libdbus-1-3
# as transitive dependencies — they don't need explicit listing.
#
# fonts-dejavu-core IS listed explicitly: strata-session's terminal
# rasteriser needs a monospace font on disk to render SSH sessions for
# Guacamole Wire Compatibility Mode, and inheriting one from Chromium's
# dependency closure would break silently the day that closure changes.
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
        curl \
        ffmpeg \
        libcairo2 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libjpeg62-turbo \
        libpng16-16 \
        libwebp7 \
        libossp-uuid16 \
        libvorbis0a \
        libvorbisenc2 \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*


COPY --from=builder /app/target/release/strata-backend /usr/local/bin/strata-backend

# guacenc + libguac (built against guacamole-server 1.6.1 in the
# guacenc-builder stage above). `services/recordings.rs::convert_guac_to_mp4`
# probes `/usr/local/bin/guacenc` first, so that's where we land it.
# libguac.so must be discoverable by the dynamic loader; ldconfig picks
# up /usr/local/lib because it's on the default search path in Debian.
COPY --from=guacenc-builder /build/usr/local/bin/guacenc /usr/local/bin/guacenc
COPY --from=guacenc-builder /build/usr/local/lib/ /usr/local/lib/
RUN ldconfig

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

RUN mkdir -p /app/config /app/migrations /app/audit-anchor
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
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

