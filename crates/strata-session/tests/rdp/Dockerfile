# Minimal xrdp target for the strata-session live RDP tests.
#
# NOTE: xrdp does not implement NLA (CredSSP) server-side. That is not a
# misconfiguration here — it is the point. The engine advertises CredSSP
# only, so this container is the target that proves it refuses a server
# offering the legacy security layer. Tests that need a *successful*
# session require a real NLA-capable target (Windows,
# gnome-remote-desktop, FreeRDP shadow); see tests/rdp_live.rs.
#
# Deliberately password-authenticated with a well-known credential: this
# image exists only to be connected to from a test on an isolated Docker
# network, and must never be published or run anywhere reachable.
FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xrdp \
        xorgxrdp \
        xterm \
        dbus-x11 \
        x11-xserver-utils \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash strata \
    && echo 'strata:strata-test-password' | chpasswd \
    && adduser xrdp ssl-cert

# Require Network Level Authentication. The engine hard-codes CredSSP,
# so a target that only offers the legacy TLS security layer would let a
# broken NLA implementation pass the tests unnoticed.
RUN sed -i 's/^security_layer=.*/security_layer=negotiate/' /etc/xrdp/xrdp.ini \
    && sed -i 's/^crypt_level=.*/crypt_level=high/' /etc/xrdp/xrdp.ini \
    && sed -i 's/^#\?tls_ciphers=.*/tls_ciphers=HIGH/' /etc/xrdp/xrdp.ini

# A bare xterm is enough to produce a framebuffer and graphics updates
# without dragging in a whole desktop environment.
RUN printf '#!/bin/sh\nexec xterm\n' > /home/strata/.xsession \
    && chmod +x /home/strata/.xsession \
    && chown strata:strata /home/strata/.xsession

EXPOSE 3389
CMD ["/bin/sh", "-c", "/usr/sbin/xrdp-sesman --nodaemon & exec /usr/sbin/xrdp --nodaemon"]
