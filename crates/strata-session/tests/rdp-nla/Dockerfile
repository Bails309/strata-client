# NLA-capable RDP target for the strata-session live RDP tests.
#
# Windows cannot serve this role here: Windows containers require a
# Windows container host and ship no RDP server or desktop, and running
# Windows in a VM under Docker needs KVM passthrough plus a licensed
# multi-gigabyte ISO. FreeRDP's shadow server speaks the same CredSSP
# handshake and runs natively, which is what the engine actually needs
# exercised.
#
# Contrast with ../rdp/Dockerfile, which is xrdp and deliberately cannot
# do NLA — that one exists to prove the engine refuses such targets.
#
# Deliberately password-authenticated with a well-known credential: this
# image exists only to be connected to from a test on an isolated Docker
# network, and must never be published or run anywhere reachable.
FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        freerdp3-shadow-x11 \
        winpr3-utils \
        xvfb \
        xterm \
        x11-utils \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# FreeRDP's NLA path authenticates against an NTLM SAM rather than PAM.
# Format is user:domain:LM:NT:::  — domain and LM hash are left empty.
RUN mkdir -p /etc/winpr \
    && printf 'strata:::%s:::\n' \
        "$(winpr-hash3 -u strata -p strata-test-password)" > /etc/winpr/SAM \
    && chmod 600 /etc/winpr/SAM

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3389
CMD ["/entrypoint.sh"]
