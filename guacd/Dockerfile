# ─── Custom guacd with FreeRDP 3 + Kerberos ───────────────────────────
# Based on apache/guacamole-server with customisations for:
#   • FreeRDP 3 (required for Kerberos/NLA authentication)
#   • Kerberos/GSSAPI build-time & runtime libraries
#
# FreeRDP 3 is sourced from Alpine edge; the rest of the base stays on 3.21.
# Patches from sol1/rustguac fix FreeRDP 3 API compatibility and add
# Kerberos NLA support.
#
# Pinned to guacamole-server commit 4163ead (head of staging/1.6.1 as of
# May 3, 2026). NOTE: GUACAMOLE-2273 (FreeRDP 3.25 AuthenticateEx, upstream
# commit 7696572) has NOT yet landed on staging/1.6.1 at this pin, so our
# local patch 006 is still required to build against FreeRDP 3.25 (which
# removed the legacy `Authenticate` callback from struct rdp_freerdp).
# Other notable fixes since 2980cf0:
# GUACAMOLE-2268 (VNC UTF-8 clipboard), GUACAMOLE-2271 (VNC
# FinishedFrameBufferUpdate), GUACAMOLE-2255 (RDP uninitialized var),
# GUACAMOLE-2264 (FreeRDP CMAKE_BUILD_TYPE=Release), GUACAMOLE-2259 (cursor
# sync skip), GUACAMOLE-2213 (OSC handling), GUACAMOLE-2241 (display plan
# infinite loop), GUACAMOLE-2221 (RDP busy-loop on transport failure),
# GUACAMOLE-2238 (EINTR retry), GUACAMOLE-2182 (config.h segfaults),
# GUACAMOLE-2035 (Dockerfile health check start period).
# ──────────────────────────────────────────────────────────────────────

# ── Builder stage ─────────────────────────────────────────────────────
# Pinned base image (W1-7): digest refreshed automatically by Renovate /
# Dependabot (see [.github/dependabot.yml](.github/dependabot.yml) docker ecosystem).
FROM alpine:3.23@sha256:4d889c14e7d5a73929ab00be2ef8ff22437e7cbc545931e52554a7b00e123d8b AS builder
# tag: alpine:3.23

# Add Alpine edge repos for FreeRDP 3 (required for Kerberos/NLA)
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories && \
    echo "https://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories

RUN apk add --no-cache \
        autoconf automake gcc g++ make libtool pkgconf \
        cairo-dev libjpeg-turbo-dev libpng-dev \
        ossp-uuid-dev pango-dev  \
        libssh2-dev libvncserver-dev libwebsockets-dev \
        pulseaudio-dev openssl-dev libvorbis-dev libwebp-dev \
        freerdp-dev \
        krb5-dev \
        ffmpeg-dev \
        git cmake

# Clone guacamole-server pinned to known-good commit (compatible with patches)
RUN git clone https://github.com/apache/guacamole-server.git /src && \
    cd /src && git checkout 4163ead8be54baa35ef5f7ad8897a57497649112

# Apply FreeRDP 3 compatibility + Kerberos NLA patches (from sol1/rustguac)
COPY patches/ /tmp/patches/
RUN apk add --no-cache patch && cd /src && \
    for p in /tmp/patches/*.patch; do \
        echo "Applying $(basename $p)..." && \
        (git apply "$p" 2>/dev/null || patch -p1 -F3 < "$p") || { echo "ERROR: Patch $(basename $p) failed to apply" && exit 1; }; \
    done && \
    grep -q '#include <freerdp/version.h>' src/protocols/rdp/rdp.c || { echo "ERROR: 006 patch did not add freerdp/version.h include" && exit 1; } && \
    grep -q 'rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;' src/protocols/rdp/rdp.c || { echo "ERROR: 006 patch did not introduce AuthenticateEx assignment" && exit 1; }

WORKDIR /src

RUN autoreconf -fi && \
    ./configure \
        --prefix=/usr/local \
        --with-ssh \
        --with-vnc \
        --with-pulse \
        --with-vorbis \
        --with-webp \
        --with-websockets && \
    make -j"$(nproc)" && \
    make DESTDIR=/build install && \
    # Defence-in-depth: every protocol Strata exposes must end up as a built
    # libguac-client-*.so. Catch silent regressions where a missing -dev
    # package on the build host causes configure to skip a protocol without
    # failing the build (e.g. libwebsockets-dev → kubernetes).
    for proto in rdp ssh vnc kubernetes; do \
        test -f /build/usr/local/lib/libguac-client-$proto.so \
            || { echo "ERROR: libguac-client-$proto.so was not built" && exit 1; }; \
    done

# ── Runtime stage ─────────────────────────────────────────────────────
FROM alpine:3.23@sha256:4d889c14e7d5a73929ab00be2ef8ff22437e7cbc545931e52554a7b00e123d8b
# Add Alpine edge repos for FreeRDP 3 runtime libs (required for Kerberos/NLA)
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories && \
    echo "https://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories

RUN apk add --no-cache \
        cairo libjpeg-turbo libpng \
        ossp-uuid libuuid pango \
        libssh2 libvncserver libwebsockets \
        libpulse openssl libvorbis libwebp \
        freerdp-libs \
        krb5 krb5-libs \
        ffmpeg-libs \
        font-misc-misc ttf-dejavu \
        netcat-openbsd \
        su-exec

COPY --from=builder /build/usr/local /usr/local
COPY --from=builder /build/usr/lib/freerdp3 /usr/lib/freerdp3

# FreeRDP plugin symlinks (guacd loads by name "guac-common-svc", not "libguac-common-svc-client")
RUN if [ -f /usr/lib/freerdp3/libguac-common-svc-client.so ]; then \
        ln -sf libguac-common-svc-client.so /usr/lib/freerdp3/guac-common-svc.so; \
    fi

# Shared library path
RUN ldconfig /usr/local/lib || true

# Recordings & drive volume mount points
RUN mkdir -p /var/lib/guacamole/recordings /var/lib/guacamole/drive /app/config && \
    chmod 0750 /var/lib/guacamole/recordings /var/lib/guacamole/drive

# Non-root user (entrypoint drops to this after applying DNS config)
RUN addgroup -S guacd && adduser -S guacd -G guacd \
    && chown -R guacd:guacd /var/lib/guacamole

# Entrypoint wrapper — applies custom DNS then execs guacd as non-root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 4822

ENTRYPOINT ["/entrypoint.sh"]
CMD ["-b", "0.0.0.0", "-L", "info", "-f"]
