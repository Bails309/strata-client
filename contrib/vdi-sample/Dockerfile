# Strata VDI sample image — minimal Ubuntu desktop reachable over xrdp:3389.
#
# This image is **a starting point**, not a production target. Operators are
# expected to fork it and bake in their own apps, fonts, language packs,
# corporate cert bundle, etc., before publishing under their own registry
# entry and adding the resulting `<registry>/<repo>:<tag>` to the
# `vdi_image_whitelist` system setting.
#
# Runtime contract (must be preserved by any forked image):
#   - xrdp listens on 3389 inside the container
#   - The init script reads VDI_USERNAME and VDI_PASSWORD from the
#     environment (injected by Strata at container start) and ensures a
#     local Linux account exists with that password before starting xrdp
#   - /home/<user> is the persistent-home mount point (Strata bind-mounts
#     <home_base>/<container_name> here when persistent_home=true)
#
# Build:
#   docker build -t strata/vdi-sample:1.0.0 .
#
# Then add `strata/vdi-sample:1.0.0` to Admin → Settings → VDI image
# whitelist (newline- or comma-separated, exact match — no glob/digest
# substitution).

FROM ubuntu:24.04@sha256:cdb5fd928fced577cfecf12c8966e830fcdf42ee481fb0b91904eeddc2fe5eff

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Minimal XFCE desktop + xrdp + a sensible set of bundled apps.
# `xorgxrdp` is required for the X11 backend; xrdp falls back to VNC
# without it. `dbus-x11` is required by XFCE session startup.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        xrdp \
        xorgxrdp \
        xfce4 \
        xfce4-terminal \
        dbus-x11 \
        sudo \
        ca-certificates \
        locales \
        firefox \
    && locale-gen en_GB.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# xrdp ships with a permissive default sesman.ini; tighten the obvious
# knobs. Operators should review /etc/xrdp/{xrdp,sesman}.ini for their
# threat model before publishing.
RUN sed -i \
        -e 's/^#\?MaxSessions=.*/MaxSessions=1/' \
        -e 's/^#\?KillDisconnected=.*/KillDisconnected=true/' \
        -e 's/^#\?DisconnectedTimeLimit=.*/DisconnectedTimeLimit=0/' \
        -e 's/^#\?IdleTimeLimit=.*/IdleTimeLimit=0/' \
        /etc/xrdp/sesman.ini && \
    sed -i \
        -e 's/^#\?security_layer=.*/security_layer=tls/' \
        -e 's/^#\?crypt_level=.*/crypt_level=high/' \
        /etc/xrdp/xrdp.ini

# XFCE is the default session for any user without an explicit choice.
RUN echo 'xfce4-session' > /etc/skel/.xsession && \
    chmod +x /etc/skel/.xsession

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3389

# xrdp must run as root (it manages PAM + creates display sockets); the
# session itself drops privileges to VDI_USERNAME via PAM.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
