#!/bin/sh
set -e

# A framebuffer for the shadow server to mirror, plus something drawn on
# it so graphics updates actually occur.
Xvfb :0 -screen 0 1024x768x24 -nolisten tcp &
for _ in $(seq 1 30); do
    [ -e /tmp/.X11-unix/X0 ] && break
    sleep 0.2
done

DISPLAY=:0 xterm -geometry 80x24+0+0 &

# NLA authenticates against the NTLM SAM built at image build time; the
# shadow server generates its own TLS certificate on first run.
exec env DISPLAY=:0 freerdp-shadow-cli3 \
    /port:3389 \
    /sec:nla \
    /sam-file:/etc/winpr/SAM
