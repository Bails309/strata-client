# Strata VDI Kali image — full Kali Linux XFCE desktop reachable over xrdp:3389.
#
# Forked from contrib/vdi-sample/. Preserves the same runtime contract
# (xrdp on 3389, reads VDI_USERNAME/VDI_PASSWORD, /home/<user> is the
# persistent-home root, container exits when xrdp exits) so the
# DockerVdiDriver and the reaper need zero changes to spawn it.
#
# NOTE on the base image: Kali does not publish stable per-tag digests
# the way Debian/Ubuntu do — `kalilinux/kali-rolling` is a moving
# target by design. We accept that and instead pin **our** image with
# an immutable build-arg tag (see KALI_BASE_TAG / image tag below).
# Operators who need digest-level reproducibility should rebuild from
# a vendored base or mirror the upstream tag into their own registry
# at a known digest.
#
# Build (default: kali-linux-large, ~9 GB — the practical "all tools"
# tier; pulls every metapackage category except the everything-bundle):
#
#   docker build -t strata/vdi-kali:2026.06.09 ./contrib/vdi-kali
#
# Build with the absolute-everything tool set (~15 GB+, slow pull,
# painful to refresh — only choose this if you really need every
# package in the Kali repos):
#
#   docker build \
#       --build-arg KALI_METAPACKAGE=kali-linux-everything \
#       -t strata/vdi-kali-everything:2026.06.09 \
#       ./contrib/vdi-kali
#
# Build a thinner variant (~5 GB, the "kali installer default" tool set):
#
#   docker build \
#       --build-arg KALI_METAPACKAGE=kali-linux-default \
#       -t strata/vdi-kali-default:2026.06.09 \
#       ./contrib/vdi-kali
#
# Then add the resulting `<repo>:<tag>` to Admin -> Settings -> VDI
# image whitelist (newline- or comma-separated, exact match — no glob,
# no tag substitution, no digest fuzziness).

ARG KALI_BASE_TAG=latest
FROM kalilinux/kali-rolling:${KALI_BASE_TAG}

# kali-linux-large is the practical "all the tools" tier — it covers
# every Kali tool category (web, wireless, forensics, exploitation,
# reverse engineering, etc.) without the multi-GB tail of
# kali-linux-everything. Override at build time if you need more.
ARG KALI_METAPACKAGE=kali-linux-large

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Two-stage install:
#   1. xrdp + XFCE + bootstrap utilities (small, cached).
#   2. The chosen Kali metapackage (large, frequently invalidated).
# Splitting keeps incremental rebuilds fast when only the metapackage
# version changes.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        xrdp \
        xorgxrdp \
        kali-desktop-xfce \
        xfce4-terminal \
        dbus-x11 \
        sudo \
        ca-certificates \
        locales \
    && locale-gen en_GB.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ${KALI_METAPACKAGE} \
    && rm -rf /var/lib/apt/lists/*

# Same xrdp hardening as the sample image: single session per
# container, no idle/disconnected reconnect window (the Strata reaper
# owns lifecycle), TLS security layer.
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

# Pick up Kali's branded XFCE session (themes, panel layout, menu).
# Using startxfce4 rather than bare xfce4-session pulls in the
# distribution defaults the user expects from a normal Kali login.
RUN echo 'startxfce4' > /etc/skel/.xsession && \
    chmod +x /etc/skel/.xsession

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3389

# xrdp must run as root (PAM + display socket creation); the
# interactive session drops privileges to VDI_USERNAME via PAM.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
