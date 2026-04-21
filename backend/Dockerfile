# ── Build stage ────────────────────────────────────────────────────────
# Pinned base images (W1-5): digests refreshed automatically by Renovate /
# Dependabot (see [.github/dependabot.yml](.github/dependabot.yml) docker ecosystem).
# Update the `# tag:` comment on the same line so humans still know which
# upstream version the digest corresponds to.
FROM rust:1.94-alpine@sha256:77237dd363a0b127bb5ef532c2d64c0deb380b738e43a9c4bdac73398d6d0a08 AS builder
# tag: rust:1.94-alpine

RUN apk add --no-cache musl-dev pkgconf openssl-dev openssl-libs-static

WORKDIR /app
COPY backend/Cargo.toml ./
COPY backend/Cargo.lock* ./
COPY VERSION ./
# Create dummy main for dependency caching
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release 2>/dev/null || true
RUN rm -rf src

COPY backend/ .
RUN touch src/main.rs && cargo build --release

# ── Runtime stage ─────────────────────────────────────────────────────
FROM alpine:3.19@sha256:6baf43584bcb78f2e5847d1de515f23499913ac9f12bdf834811a3145eb11ca1
# tag: alpine:3.19

RUN apk add --no-cache ca-certificates krb5 openldap-clients cyrus-sasl-gssapiv2 su-exec

COPY --from=builder /app/target/release/strata-backend /usr/local/bin/strata-backend

RUN mkdir -p /app/config /app/migrations
COPY backend/migrations /app/migrations

# Non-root user. The entrypoint fixes ownership on Docker volumes then drops to strata.
RUN addgroup -S strata && adduser -S strata -G strata \
    && chown -R strata:strata /app \
    && mkdir -p /var/lib/guacamole/recordings /var/lib/guacamole/drive \
    && chown -R strata:strata /var/lib/guacamole

WORKDIR /app
EXPOSE 8080

COPY backend/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
