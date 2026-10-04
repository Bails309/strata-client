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
FROM rust:1.99-bookworm@sha256:59037199c44290f2befcdd58dcc540164763fc296950255aaefeef096a1866b0 AS builder
WORKDIR /src

# Workspace context — copy the bits the DMZ crate actually needs.
COPY Cargo.toml Cargo.lock ./
COPY crates/strata-protocol ./crates/strata-protocol
COPY crates/strata-dmz ./crates/strata-dmz
# The other workspace members and the [patch.crates-io] forks must exist for
# the workspace to resolve; none of them enter the DMZ binary.
COPY backend/Cargo.toml ./backend/Cargo.toml
COPY crates/strata-session/Cargo.toml ./crates/strata-session/Cargo.toml
COPY crates/vendor ./crates/vendor
RUN mkdir -p backend/src crates/strata-session/src \
 && echo "fn main(){}" > backend/src/main.rs \
 && : > crates/strata-session/src/lib.rs

RUN cargo build --release --locked -p strata-dmz \
 && strip target/release/strata-dmz

# -- runtime ---------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:e2d29aec8061843706b7e484c444f78fafb05bfe47745505252b1769a05d14f1 AS runtime
COPY --from=builder /src/target/release/strata-dmz /usr/local/bin/strata-dmz

USER nonroot:nonroot
EXPOSE 8443 8444
ENTRYPOINT ["/usr/local/bin/strata-dmz"]
