# ADR-0004 — guacd connection model and security boundaries

- **Status**: Accepted
- **Date**: 2026-04-21
- **Wave**: W5-10
- **Related standards**: §4 (authn/z), §12 (protocol handling), §15 (network boundaries)
- **Supersedes**: —
- **Superseded by**: —

## Context

Strata brokers RDP / VNC / SSH sessions to target hosts via
[Apache guacd](https://guacamole.apache.org/). guacd is a native
protocol translator: it speaks the Guacamole protocol on its client
socket and RDP/VNC/SSH on its server socket. The browser never
touches guacd directly — it talks to the Strata backend over a
WebSocket, and the backend proxies the Guacamole protocol to guacd.

This puts three trust boundaries in the hot path:

1. **Browser ↔ backend** — TLS, JWT-authenticated WebSocket upgrade.
2. **Backend ↔ guacd** — plaintext TCP on a private Docker network.
3. **guacd ↔ target host** — RDP/VNC/SSH with per-session credentials
   that the backend injects at handshake time.

Key design questions we need to pin:

* How does the backend authenticate a user's request to open a
  specific connection, and prevent one user from tunneling into
  another user's target?
* What credentials does guacd see, where do they come from, and how
  long do they live?
* What is the network exposure of the guacd container?
* What filtering is applied to Guacamole protocol parameters that
  originate from user-controlled database fields?

## Decision

**Accept the current split-trust model with the following invariants.**

### 1. guacd is never directly reachable from the browser

* guacd binds **only** on the internal Docker network
  (`strata-internal`). Its port (4822) is never published to the
  host via `docker-compose.yml`.
* All Guacamole protocol frames pass through
  [backend/src/tunnel.rs](backend/src/tunnel.rs), which acts as an
  application-level proxy: it terminates the browser's WebSocket,
  authenticates the user via JWT, and only then opens a TCP socket
  to guacd.
* This means the guacd process treats the backend as a trusted
  peer; there is no separate authentication between backend and
  guacd. The boundary is enforced at the Docker network level.

### 2. Session credentials are ephemeral and per-handshake

* The backend resolves the target credential at session-open time:
  either from a stored connection (sealed via Vault Transit — see
  ADR-0006) or from a just-in-time Password Manager checkout.
* Credentials are injected into the guacd `connect` instruction as
  protocol parameters and **never persisted to guacd state**. guacd
  holds them only in the address space of the session process, which
  exits when the session closes.
* Recording is optional and, when enabled, is captured by the
  backend's proxy (not by guacd) to keep the credential out of any
  on-disk artefact.

### 3. Protocol-parameter allow-list

User-provided parameters that arrive via the connection's
`extra` JSONB column (e.g. `color-depth`, `enable-wallpaper`) are
filtered through `is_allowed_guacd_param` in
[backend/src/tunnel.rs](backend/src/tunnel.rs). Parameter names not on
the allow-list are dropped silently before the frame is forwarded to
guacd. This prevents an authenticated user (or a compromised
connection row) from injecting arbitrary protocol flags — for
example, `drive-path` (which would enable drive redirection) is not
on the allow-list and cannot be turned on from the database.

### 4. Authorisation is performed before the socket is opened

The `/api/tunnel` handler:

1. Validates the JWT and extracts the user.
2. Loads the target connection.
3. Runs the resource-ownership / role-permission check exactly the
   same way as the REST endpoints do.
4. Only then resolves credentials and dials guacd.

If any of steps 1–3 fails, no TCP connection to guacd is ever made
and no credential is ever read from the vault.

### 5. Resource caps and watchdogs

* Per-session iteration timeout lives in the shared worker harness
  so that a stuck guacd stream cannot pin a tokio task indefinitely.
* The backend enforces a maximum concurrent-session count per user
  (§12.4) before calling guacd, so a compromised account cannot
  exhaust guacd worker slots.

## Consequences

**Positive**

* A container-break-out into guacd cannot directly enumerate or
  exfiltrate other users' credentials because guacd never stores
  them and the database lives in a separate service.
* The Guacamole protocol's considerable attack surface never faces
  the public internet.
* Every authorization decision is made in Rust, not in guacd
  configuration files, so the policy source of truth is one place.

**Negative**

* Horizontal scale-out requires every backend replica to be able to
  reach guacd. In a multi-node deployment this means a private
  overlay network (or WireGuard mesh) between backend nodes and the
  guacd pool. Single-instance deployments are covered by
  `strata-internal`.
* The parameter allow-list must be kept up to date as new guacd
  features land. A new allow-list entry is a security review item.
* Recording-capture in the proxy means backend CPU cost per session
  is higher than offloading to guacd — accepted trade-off for
  credential safety.

## Implementation notes

* Proxy: [backend/src/tunnel.rs](backend/src/tunnel.rs).
* Allow-list: `is_allowed_guacd_param` in the same file.
* Network isolation: `docker-compose.yml` only publishes the nginx
  container; `guacd` and `backend` talk over `strata-internal`.
* Patches to upstream guacd (hardening, CVE back-ports) live in
  [guacd/patches/](guacd/patches/) and are applied at image build
  time.

## Threat model summary

| Threat | Mitigation |
|---|---|
| Browser-originating CSRF to open a tunnel | JWT-on-WebSocket-upgrade + `SameSite=Strict` cookie (ADR-0002) |
| Stealing another user's target credential | Authorisation before socket open; credential held in memory only |
| Guacamole protocol injection via DB | `is_allowed_guacd_param` allow-list |
| guacd RCE from a malicious target server | Container sandbox (`cap_drop: ALL`, `no-new-privileges`); guacd container has no outbound internet except to target LAN |
| Long-lived credential leak via recording | Recordings captured by proxy, not guacd; recording retention enforced by W5-1 purge |
