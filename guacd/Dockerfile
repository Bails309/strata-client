# ─── Custom guacd with FreeRDP 3 + Kerberos ───────────────────────────
# Based on apache/guacamole-server with customisations for:
#   • FreeRDP 3 (required for Kerberos/NLA authentication)
#   • Kerberos/GSSAPI build-time & runtime libraries
#
# FreeRDP 3 is sourced from Alpine edge; the rest of the base stays on 3.21.
# Patches from sol1/rustguac fix FreeRDP 3 API compatibility and add
# Kerberos NLA support.
#
# Pinned to guacamole-server commit be83001 on **main** (2026-08-07). `main`
# is upstream's development trunk: work flows staging/1.6.1 → patch → main, so
# be83001 provably contains f22a2df, the head of staging/1.6.1 at time of
# pinning. Both branches declare version 1.6.1 in configure.ac.
#
# Moved off staging/1.6.1 (was 4163ead) because RDP support for the
# `clipboard-buffer-size` parameter exists only on main. On staging/1.6.1 the
# RDP clipboard is a fixed 256 KiB buffer with a *stack-allocated* receive
# array, and overrunning it is silent: guac_iconv() fails and
# guac_rdp_cliprdr_format_data_response() skips reset/append/send entirely,
# so a large copy is dropped wholesale rather than truncated. main allocates
# that buffer on the heap and honours the parameter.
#
# Notable fixes gained over 4163ead:
#   GUACAMOLE-2273 (FreeRDP AuthenticateEx — obsoletes our local patch 006),
#   GUACAMOLE-1625 (sockets inherited by connection processes; parents were
#   observed holding tens of GB), GUACAMOLE-2118 (connection processes
#   blocked forever when a user vanishes without `disconnect`),
#   GUACAMOLE-2270 (ABBA deadlock between guac_display_dup() and frame
#   flush), GUACAMOLE-2315 (libwebsockets 5.0.0 build), GUACAMOLE-2314
#   (guacd start without guacd.conf), GUACAMOLE-2294/2295 (resource leaks),
#   GUACAMOLE-2313 (lock modifiers / macOS keys).
#
# Pin the SHA, never the branch name — main moves.
# ──────────────────────────────────────────────────────────────────────

# ── Builder stage ─────────────────────────────────────────────────────
# Pinned base image (W1-7): digest refreshed automatically by Renovate /
# Dependabot (see [.github/dependabot.yml](.github/dependabot.yml) docker ecosystem).
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS builder
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
    cd /src && git checkout be83001bda2e60f1356604c91144628e8150afeb

# Apply FreeRDP 3 compatibility + Kerberos NLA patches (from sol1/rustguac)
COPY patches/ /tmp/patches/
RUN apk add --no-cache patch && cd /src && \
    for p in /tmp/patches/*.patch; do \
        echo "Applying $(basename $p)..." && \
        (git apply "$p" 2>/dev/null || patch -p1 -F3 < "$p") || { echo "ERROR: Patch $(basename $p) failed to apply" && exit 1; }; \
    done && \
    grep -q 'AuthenticateEx' src/protocols/rdp/rdp.c || { echo "ERROR: upstream AuthenticateEx support missing — patch 006 may need reinstating" && exit 1; } && \
    grep -q '"clipboard-buffer-size"' src/protocols/rdp/settings.c || { echo "ERROR: RDP does not accept clipboard-buffer-size at this pin — large copies would be silently dropped" && exit 1; }

WORKDIR /src

RUN autoreconf -fi && \
    ./configure \
        --prefix=/usr/local \
        --enable-guacenc \
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
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
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
# Normalize line endings to LF to avoid CRLF shebang issues when built on Windows hosts
RUN sed -i 's/\r$//' /entrypoint.sh && \
    chmod +x /entrypoint.sh

EXPOSE 4822

ENTRYPOINT ["/entrypoint.sh"]
CMD ["-b", "0.0.0.0", "-L", "info", "-f"]
