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
FROM alpine:3.21 AS builder

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
RUN cd /src && \
    for p in /tmp/patches/*.patch; do \
        echo "Applying $(basename $p)..." && \
        git apply "$p" || { echo "ERROR: Patch $(basename $p) failed to apply" && exit 1; }; \
    done

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
FROM alpine:3.21

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
        netcat-openbsd

COPY --from=builder /build/usr/local /usr/local
COPY --from=builder /build/usr/lib/freerdp3 /usr/lib/freerdp3

# FreeRDP plugin symlinks (guacd loads by name "guac-common-svc", not "libguac-common-svc-client")
RUN if [ -f /usr/lib/freerdp3/libguac-common-svc-client.so ]; then \
        ln -sf libguac-common-svc-client.so /usr/lib/freerdp3/guac-common-svc.so; \
    fi

# Shared library path
RUN ldconfig /usr/local/lib || true

# Recordings & drive volume mount points
RUN mkdir -p /var/lib/guacamole/recordings /var/lib/guacamole/drive && \
    chmod 0750 /var/lib/guacamole/recordings /var/lib/guacamole/drive

# Run as non-root user
RUN addgroup -S guacd && adduser -S guacd -G guacd \
    && chown -R guacd:guacd /var/lib/guacamole
USER guacd

EXPOSE 4822

ENTRYPOINT ["/usr/local/sbin/guacd"]
CMD ["-b", "0.0.0.0", "-L", "info", "-f"]
