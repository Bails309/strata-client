# ─── Custom guacd with FreeRDP 3 + Kerberos ───────────────────────────
# Based on apache/guacamole-server with customisations for:
#   • FreeRDP 3 (required for Kerberos/NLA authentication)
#   • Kerberos/GSSAPI build-time & runtime libraries
#
# FreeRDP 3 is sourced from Alpine edge; the rest of the base stays on 3.21.
# Patches from sol1/rustguac fix FreeRDP 3 API compatibility and add
# Kerberos NLA support.
#
# Pinned to guacamole-server commit 2980cf0 (known-good with these patches).
# ──────────────────────────────────────────────────────────────────────

# ── Builder stage ─────────────────────────────────────────────────────
# Pinned base image (W1-7): digest refreshed automatically by Renovate /
# Dependabot (see [.github/dependabot.yml](.github/dependabot.yml) docker ecosystem).
FROM alpine:3.23 AS builder
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
    cd /src && git checkout 2980cf0

# Apply FreeRDP 3 compatibility + Kerberos NLA patches (from sol1/rustguac)
COPY patches/ /tmp/patches/
RUN apk add --no-cache patch && cd /src && \
    for p in /tmp/patches/*.patch; do \
        echo "Applying $(basename $p)..." && \
        (git apply "$p" 2>/dev/null || patch -p1 -F3 < "$p") || { echo "ERROR: Patch $(basename $p) failed to apply" && exit 1; }; \
    done

# FreeRDP 3.25 (Alpine edge) removed the legacy `Authenticate` callback field
# from `struct rdp_freerdp` in favour of `AuthenticateEx`, which carries an
# extra `rdp_auth_reason reason` parameter. guacamole-server 1.6.1 still uses
# the old API, so we patch it in place. The substitution is unambiguous (it
# anchors on full unique lines) and is a compile-time no-op on FreeRDP < 3.25
# because the preprocessor selects the original code path.
RUN set -e; cd /src/src/protocols/rdp && \
    grep -q 'rdp_inst->Authenticate = rdp_freerdp_authenticate;' rdp.c && \
    grep -q '^static BOOL rdp_freerdp_authenticate(freerdp\* instance, char\*\* username,$' rdp.c && \
    awk -f /tmp/patches/freerdp325-authenticate-ex.awk rdp.c > rdp.c.new && \
    mv rdp.c.new rdp.c && \
    grep -q 'rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;' rdp.c && \
    grep -q 'rdp_auth_reason reason' rdp.c && \
    echo "FreeRDP 3.25 AuthenticateEx shim applied OK"

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
    make DESTDIR=/build install

# ── Runtime stage ─────────────────────────────────────────────────────
FROM alpine:3.23

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
