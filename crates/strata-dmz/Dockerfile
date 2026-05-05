# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Strata DMZ node — public-facing dumb-proxy.
#
# Hardening contract (enforced by CI):
#   * distroless base — no shell, no package manager, no debug tools
#   * statically-linked binary, stripped
#   * non-root user (uid 65532 / nonroot)
#   * read-only root filesystem at runtime (compose / k8s flag)
#   * no DB / Vault / LDAP / Kerberos / guac crates in the closure
# ---------------------------------------------------------------------------

# -- builder ---------------------------------------------------------------
FROM rust:1.95-bookworm AS builder
WORKDIR /src

# Workspace context — copy the bits the DMZ crate actually needs.
COPY Cargo.toml ./
COPY crates/strata-protocol ./crates/strata-protocol
COPY crates/strata-dmz ./crates/strata-dmz
# `backend/` is a workspace member but has no impact on the DMZ binary;
# we still need its manifest present for the workspace to resolve.
COPY backend/Cargo.toml ./backend/Cargo.toml
RUN mkdir -p backend/src && echo "fn main(){}" > backend/src/main.rs

RUN cargo build --release -p strata-dmz \
 && strip target/release/strata-dmz

# -- runtime ---------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
COPY --from=builder /src/target/release/strata-dmz /usr/local/bin/strata-dmz

USER nonroot:nonroot
EXPOSE 8443 8444
ENTRYPOINT ["/usr/local/bin/strata-dmz"]
