# ADR-0009 — DMZ deployment mode (public-facing dumb-proxy)

- **Status**: Accepted
- **Date**: 2026-05-05
- **Wave**: Q2 2026 (v0.26.0 DMZ release)
- **Related standards**: §3 (network boundaries), §4.6 (secrets-at-rest), §6 (mTLS), §26 (audit)
- **Related docs**: [dmz-implementation-plan.md](../dmz-implementation-plan.md), [threat-model.md](../threat-model.md), [security.md](../security.md)
- **Supersedes**: —
- **Superseded by**: —

## Context

Through v0.25.0, the only supported deployment shape exposed the
backend node directly to the internet (or to an L7 reverse proxy that
operators ran themselves — typically nginx or Cloudflare). Several
prospective deployments rejected that shape outright on the basis that
**a single host that holds the Vault token, the database connection
pool, the LDAP bind credential, the Kerberos keytab, and a public TCP
listener** is too rich a target. They wanted a small, auditable
forward-facing component holding none of those secrets, with the rich
backend reachable only over an inbound (DMZ → internal) mTLS channel
that internal-firewall rules can permit explicitly.

Three concrete requirements drove this ADR:

1. **No business secrets on the public-facing host.** The DMZ node
   must not be able to read Vault, the database, AD, or Kerberos. A
   compromise of the DMZ node must not yield credentials to the
   internal service.
2. **Inbound-only network flow from DMZ to internal**, so internal
   firewalls can be configured `internal → DMZ:443/tcp DENY` and only
   the DMZ-side mTLS listener needs an inbound rule. The internal
   node *dials out* to the DMZ.
3. **Operational visibility**: admins must be able to see DMZ-link
   health from the existing admin UI, force-reconnect a stuck link,
   and reach a separate operator endpoint on the DMZ host that does
   not share credentials with anything on the public surface.

A fourth, softer requirement: the existing single-binary "monolith"
deployment must keep working unchanged — DMZ mode is opt-in, gated
entirely on whether `STRATA_DMZ_*` env is set on the public host and
whether `STRATA_DMZ_ENDPOINTS` (plus the matching mTLS / PSK / HMAC
vars) is set on the internal host.

## Decision

**Split the public-facing surface into a new `strata-dmz` binary that
holds no Strata business secrets, and connect it to the existing
`strata-backend` binary via a long-lived inbound mTLS link carrying
HTTP/2.** Edge metadata that the internal node trusts (client IP,
TLS version, request id, link id, timestamp) is signed with HMAC-SHA-256
under a key shared only between the DMZ and the internal node.

### Three crates, three trust tiers

```
crates/strata-protocol/   # shared wire types + canonical edge-header signer
crates/strata-dmz/        # public-facing dumb-proxy (NO business secrets)
backend/                  # existing rich backend (keeps Vault, DB, LDAP, Kerberos, guacd)
```

CI (`.github/workflows/dmz-deps.yml`) enforces that
`crates/strata-dmz`'s dependency closure does **not** contain any of:
`sqlx`, `deadpool-postgres`, `vaultrs`, `ldap3`, `krb5`/`kerberos`/`gssapi`,
or any `guac*` crate. Adding one fails CI.

### Wire protocol: `strata-link/1.0`

- **Transport**: mTLS over TCP. The DMZ node listens; the internal
  node dials out and presents a client certificate signed by an
  operator-controlled CA.
- **Handshake**: a single length-prefixed JSON exchange
  (`PROTOCOL_VERSION_STR = "strata-link/1.0"`) carrying the cluster
  id, node id, software version, and a 32-byte challenge MAC under a
  preshared symmetric key (PSK rotation supported via the
  `STRATA_DMZ_LINK_PSKS` map: `current:...`, `previous:...`).
- **Application layer**: HTTP/2 (h2 0.4) inside the established mTLS
  tunnel. The DMZ node holds an `h2::client::SendRequest<Bytes>` per
  link; the internal node runs `h2::server::Builder` over the same
  tunnel.

### Reverse-proxy adapter

The DMZ public listener terminates TLS itself (rustls 0.23, ring
provider, ALPN `h2` then `http/1.1`) and forwards every non-health
request through an `h2::client::SendRequest` picked from the link
session registry. Highlights:

- **Symmetric body cap** (`MAX_PROXY_BODY_BYTES = 8 MiB`) on both
  request and response so neither direction can amplify the other.
- **Hop-by-hop headers stripped** per RFC 7230 §6.1
  (`connection`, `proxy-connection`, `keep-alive`, `transfer-encoding`,
  `te`, `trailer`, `upgrade`, plus `host` since h2 uses `:authority`,
  plus any header listed in the value of `connection:`).
- **Two-attempt forwarding**: on a `LinkSendUnavailable` /
  `UpstreamHandshake` error on the first attempt, the registry entry
  is evicted and one retry runs on a fresh pick. We do not loop —
  the public client retries instead of holding a request open across
  multiple link reconnects.
- **All proxy errors carry `x-strata-link: dmz-proxy`** so admins can
  distinguish DMZ-injected responses from upstream-shaped ones in
  logs.

### Edge-header signer

```rust
trait EdgeSigner {
    fn sign(&self, headers: &mut HeaderMap, peer: Option<SocketAddr>,
            method: &http::Method, uri: &Uri);
}
```

The production `HmacEdgeSigner`:

1. **Strips every incoming `x-strata-edge-*` header first** so a
   public client cannot inject pre-signed values.
2. Populates the canonical 8-field bundle: `client-ip`, `tls-version`,
   `tls-cipher`, `tls-ja3`, `user-agent` (truncated to 1 KiB),
   `request-id` (preserved if printable ASCII ≤ 128 chars, else
   freshly minted UUID v4), `link-id` (= node_id), `timestamp-ms`
   (Unix ms).
3. Computes `HMAC-SHA-256` over the canonicalised bundle using a key
   held in `Zeroizing<Vec<u8>>`, emits the base64 MAC as
   `x-strata-edge-trusted-mac`.

`X-Forwarded-For` from the public client is honoured **only** when
the socket peer is in the configured `trust_forwarded_from` list, and
even then only walking the chain right-to-left to find the rightmost
untrusted hop. From any untrusted peer the signer falls back to the
socket peer's IP, then `0.0.0.0`.

The internal node's verifier uses
`strata_protocol::edge_header::verify` against a list of currently
trusted keys (rotation), then `check_timestamp` with a
`MAX_TIMESTAMP_SKEW_MS = 60_000` window.

### Abuse mitigation on the public surface

A four-layer tower stack (outermost → innermost):

1. **Per-IP rate limit** (`PerIpRateLimiter`, 16-stripe milli-token
   bucket). Drops bad actors before any work and answers
   `429 retry-after: 1`.
2. **Global concurrency cap** (`tower::limit::GlobalConcurrencyLimitLayer`)
   bounds tail latency under load.
3. **Request timeout** (`tower_http::timeout::TimeoutLayer`,
   default 1 s minimum) defends against slow-loris.
4. **Body limit** (`tower_http::limit::RequestBodyLimitLayer`)
   defends against memory exhaustion. The proxy enforces the same
   8 MiB cap end-to-end.

### Operator surface

A **separate listener** on `STRATA_DMZ_OPERATOR_BIND` (default
`127.0.0.1:9444`) exposes:

- `GET /status` — cluster id, node id, uptime, links_up, version
- `GET /links` — per-session JSON (link_id, cluster_id, node_id,
  software_version, age_secs)
- `POST /links/{link_id}/disconnect` — evict a session

Authentication is a constant-time bearer-token compare
(`subtle::ConstantTimeEq`, length-checked) against
`STRATA_DMZ_OPERATOR_TOKEN` (min 32 bytes, scrubbed from `std::env`
post-parse). The token shares **no** material with the link PSK or
the edge HMAC key — a leak of one does not yield the others.

The operator listener runs over plaintext HTTP by design: it is
intended to be reachable only over a private management network. The
loopback default protects against firewall misconfiguration.

### Internal-side admin API

- `GET /api/admin/dmz-links` — supervisor snapshot (per-endpoint
  state, connects/failures counters, since-timestamp, last_error)
- `POST /api/admin/dmz-links/reconnect` — best-effort kick that marks
  every endpoint `Backoff` so the supervisor's next tick redials

Both routes inherit the existing admin layer stack
(`require_csrf` → `require_auth` → `require_admin`) — no new authn /
authz path. The frontend renders the snapshot in a new **DMZ Links**
admin tab.

## Consequences

### Positive

- **Smaller blast radius on the public host.** A full RCE on the DMZ
  node yields the link PSK, the edge HMAC key, the operator token,
  and the public TLS key — but **not** Vault, the database, AD, or
  Kerberos. The internal node remains reachable only over the
  authenticated h2 tunnel; nothing on the DMZ host can dial it
  directly.
- **Inbound-only flow** from internal to DMZ matches conventional
  "DMZ → internal must be denied" firewall posture. The internal
  service needs no inbound rule for this feature.
- **Existing monolith deployment unaffected.** DMZ mode is purely
  opt-in.
- **Operational visibility** lands in the existing admin UI rather
  than a parallel ops console.

### Negative

- **Two-binary deployment + extra mTLS material.** Operators must
  issue a server cert + key for the DMZ link listener and a client
  cert + key for the internal node, plus distribute the link PSK and
  edge HMAC key.
- **Latency floor**: every request now traverses an extra h2 hop
  inside mTLS. In practice this is dominated by the existing guacd
  / database round-trips, but it is non-zero.
- **Three distinct secrets to rotate** (link PSK, edge HMAC key,
  operator token). The PSK rotation path is built in (`current` /
  `previous` keys); the edge HMAC key uses the same multi-key
  verifier on the internal side; the operator token is restartful.

### Neutral

- **`x-strata-link: dmz-proxy` response header** on every
  proxy-injected error is observable to public clients. This is by
  design: the DMZ surface is the public surface, and revealing
  "this came from a proxy" doesn't leak topology that wasn't
  already implied by the cert SAN.

## Alternatives considered

### A. Single-binary with `--public-only` flag

Reuse `strata-backend` and disable the rich subsystems via a flag.
**Rejected** because flags can be toggled at runtime and a
build-time guarantee is stronger; and because the dependency closure
of `strata-backend` already pulls in `sqlx`, `vaultrs`, `ldap3`, etc.
A flag that "promises not to use them" is not a security control.

### B. nginx in front of `strata-backend`

The status-quo for several existing deployments. **Rejected as an
upgrade path** because nginx does not give the internal node trusted
edge metadata (client IP, TLS metadata, request id) under MAC, and
because there is no inbound-only flow from internal to nginx —
nginx must be reachable from the backend or vice-versa, and either
direction yields the broader attack surface this ADR exists to
shrink.

### C. WireGuard tunnel between DMZ and internal, plain HTTP inside

WireGuard provides an inbound-only flow trivially, and the internal
node could dial out over WG. **Rejected** because operating WG
on customer-managed hosts adds a new dependency (kernel module or
userspace `boringtun`), because key rotation is awkward at the
WG layer (rotating a peer key requires a config reload on both
sides), and because mTLS gives us the same guarantees with the
crypto we already ship (rustls 0.23, ring) and tools customers
already operate.

### D. Tailscale / Cloudflare Tunnel

Operationally attractive but introduces a third-party control plane
into the security boundary. **Rejected** for on-prem deployments
where customers explicitly want no third-party SaaS in the path.
Nothing in this ADR prevents an operator running Tailscale around
the link if they want to layer it.

## Test coverage

Locked-in invariants (live in `crates/strata-dmz/src/proxy.rs` and
`crates/strata-dmz/src/edge_signer.rs`):

- **Forged edge headers from public clients are overwritten** —
  attacker-supplied `x-strata-edge-link-id`, `x-strata-edge-user-agent`,
  `x-strata-edge-timestamp-ms`, and `x-strata-edge-trusted-mac` are all
  replaced with the proxy's freshly-signed values before reaching the
  upstream.
- **XFF from untrusted peers is ignored** — with `trust_forwarded_from`
  empty, a public `X-Forwarded-For` does not influence
  `x-strata-edge-client-ip`.
- **No replay across requests** — two byte-identical public requests
  produce different timestamps, MACs, and request-ids.
- **End-to-end roundtrip** — h2-over-`tokio::io::duplex` exercises
  pick → sign → send → response stream; asserts the upstream
  receives the full canonical bundle and the response body is
  forwarded verbatim.
- **Operator constant-time auth** — token compare is length-safe;
  short tokens do not short-circuit to a prefix match.

## Operator runbook impact

`docs/runbooks/dmz-incident.md` covers (a) link flap (admin UI shows
endpoint stuck in `backoff`), (b) operator token compromise, (c) edge
HMAC key compromise, (d) link PSK compromise. To be authored as
part of Phase 5b alongside the Grafana dashboard at
`docs/grafana/strata-dmz-dashboard.json`.
