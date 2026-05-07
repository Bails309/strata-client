#!/usr/bin/env bash
# scripts/dmz/gen-test-certs.sh — generate mTLS material for the DMZ
# split-topology compose overlay.
#
# Output (under ./certs/dmz/):
#   ca.crt / ca.key                — local test CA
#   server.crt / server.key        — DMZ link listener cert (SAN: strata-dmz)
#   client.crt / client.key        — internal node client cert
#   public.crt / public.key        — DMZ public TLS cert (SAN: localhost)
#
# These are FOR LOCAL TESTING ONLY. Do not deploy them to anything
# reachable from a real network. The script regenerates from scratch
# every run; existing material is overwritten.
set -euo pipefail

# Prevent Git Bash / MSYS on Windows from rewriting the leading '/' in
# OpenSSL -subj arguments (e.g. '/CN=...') into a Windows path. No-op
# on Linux / macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

OUT=${OUT:-./certs/dmz}
DAYS=${DAYS:-30}
mkdir -p "$OUT"
cd "$OUT"

echo "[gen-test-certs] writing material to $(pwd) (validity: ${DAYS} days)"

# 1. CA -----------------------------------------------------------------
openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
    -subj "/CN=Strata DMZ Test CA" \
    -keyout ca.key -out ca.crt 2>/dev/null

# 2. DMZ link server cert (SAN must include the compose service name) --
# Use a temp ext-file (rather than process substitution `<(...)`) so the
# script also works in Git Bash on Windows, where /dev/fd/N is unreliable.
printf 'subjectAltName=DNS:strata-dmz,DNS:localhost,IP:127.0.0.1\n' > server.ext
openssl req -newkey rsa:2048 -nodes \
    -subj "/CN=strata-dmz" \
    -keyout server.key -out server.csr 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$DAYS" -out server.crt \
    -extfile server.ext 2>/dev/null
rm server.csr server.ext

# 3. Internal node client cert -----------------------------------------
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl req -newkey rsa:2048 -nodes \
    -subj "/CN=strata-internal" \
    -keyout client.key -out client.csr 2>/dev/null
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$DAYS" -out client.crt \
    -extfile client.ext 2>/dev/null
rm client.csr client.ext

# 4. Public TLS cert (presented to browsers) ---------------------------
openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
    -subj "/CN=localhost" \
    -keyout public.key -out public.crt \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null

chmod 0644 *.crt
# Test-cert keys are world-readable (0644) on purpose. The same
# `certs/dmz/` directory has to be readable by TWO containers running
# as DIFFERENT non-root UIDs on different hosts:
#
#   * strata-dmz on the DMZ host  -> distroless nonroot, UID 65532
#   * backend    on the internal host -> `strata` user, typically UID 999
#
# A single owner can't satisfy both, so for these test-only credentials
# we relax the mode rather than chown. The script header makes the
# "FOR LOCAL TESTING ONLY" caveat explicit; production deployments
# should bring their own CA material and chown it to the right UID
# per host (see docs/deployment.md A.1).
chmod 0644 *.key

echo "[gen-test-certs] done."
ls -la "$OUT"
