# ── Build stage ────────────────────────────────────────────────────────
FROM rust:1.94-alpine AS builder

RUN apk add --no-cache musl-dev pkgconf openssl-dev openssl-libs-static

WORKDIR /app
COPY Cargo.toml ./
COPY Cargo.lock* ./
# Create dummy main for dependency caching
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release 2>/dev/null || true
RUN rm -rf src

COPY . .
RUN touch src/main.rs && cargo build --release

# ── Runtime stage ─────────────────────────────────────────────────────
FROM alpine:3.19

RUN apk add --no-cache ca-certificates krb5 openldap-clients cyrus-sasl-gssapiv2 su-exec

COPY --from=builder /app/target/release/strata-backend /usr/local/bin/strata-backend

RUN mkdir -p /app/config /app/migrations
COPY migrations /app/migrations

# Non-root user. The entrypoint fixes ownership on Docker volumes then drops to strata.
RUN addgroup -S strata && adduser -S strata -G strata \
    && chown -R strata:strata /app \
    && mkdir -p /var/lib/guacamole/recordings /var/lib/guacamole/drive \
    && chown -R strata:strata /var/lib/guacamole

WORKDIR /app
EXPOSE 8080

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
