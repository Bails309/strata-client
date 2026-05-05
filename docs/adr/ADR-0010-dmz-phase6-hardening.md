# ADR-0010 — DMZ deployment mode hardening (W6 closure)

- **Status**: Accepted
- **Date**: 2026-06-08
- **Wave**: Q2 2026 (v0.26.0 DMZ release, follow-on hardening)
- **Related standards**: §3 (network boundaries), §6 (mTLS), §17 (rate-limit / abuse), §26 (audit)
- **Related docs**: [ADR-0009](ADR-0009-dmz-deployment-mode.md), [dmz-implementation-plan.md](../dmz-implementation-plan.md), [threat-model.md](../threat-model.md)
- **Supersedes**: —
- **Superseded by**: —

## Context

ADR-0009 stood up the DMZ deployment mode end-to-end (link server,
reverse proxy, edge-header signer, public-side TLS, abuse mitigation,
operator listener, deployment topology). The associated threat-model
section §6 enumerated five residual risks (W6-1 … W6-5) that were
intentionally left open while we shipped the baseline so we could
land them as targeted, reviewable follow-ups rather than balloon
ADR-0009's scope.

This ADR records the **hardening pass** — Phase 6 in the DMZ
implementation plan — which closes four of the five residuals and
documents why the fifth (W6-3) remains in the backlog rather than
being shipped now.

## Decision

Land Phase 6 as four narrow, sequential branches, each closing one
threat-model residual. Each branch is self-contained, ships with
tests, and is reviewer-friendly (~300 lines of diff or less).

| Branch | Phase | Closes | Summary |
|--------|-------|--------|---------|
| `feat/dmz-phase5g-toolchain-drift` | 5g | — | Track upstream `rand` 0.10 + `hmac` 0.13 API drift surfaced after the W5 cadence cut. Pre-req for the W6 work. |
| `feat/dmz-phase6a-audit-enrichment` | 6a | **W6-4** | Verified-edge attribution on every audit row: a `tokio::task_local!` carries the post-mTLS edge context (`client_ip`, `tls_version`, `tls_cipher`, `tls_ja3`, `user_agent`, `request_id`, `link_id`) into `services::audit::write`, where it is merged into `details._edge`. Operators correlate `link_id` against their known-DMZ-nodes allowlist offline. |
| `feat/dmz-phase6b-cert-hotreload` | 6b | **W6-1** | mTLS link-connector cert hot-reload: `services::dmz_link::TlsLinkConnector` now keeps its rustls `ClientConfig` behind an `RwLock<Arc<...>>`, exposes a `reload()` entrypoint, and a 60-second mtime poller (`spawn_mtime_watcher`) picks up cert-manager's PEM rewrite without a backend restart. New handshakes use rotated material; in-flight sessions are unaffected. |
| `feat/dmz-phase6c-per-ip-body-caps` | 6c | **W6-2** | Per-public-IP body-cap tuning: `STRATA_DMZ_PUBLIC_BODY_LIMITS_BY_IP` accepts a comma-separated `cidr=bytes` list (longest-prefix wins, K/M/G suffixes, IPv4 + IPv6). The new `body_cap_middleware` replaces the static `RequestBodyLimitLayer`, fast-fails on `Content-Length`, and falls back to `STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES`. As a fix-out, also stamps `ConnectInfo<SocketAddr>` manually in `HyperRouterService` (axum 0.8 `into_make_service_with_connect_info` produced an `AddExtension<Router,...>` incompatible with the bespoke hyper driver) and drops `Option<ConnectInfo<...>>` from middleware extractors (axum 0.8 split `FromRequestParts` for optional extractors). |
| _(this branch)_ `feat/dmz-phase6d-w6-completion` | 6d | docs | Completion ADR + threat-model status sweep. |

### W6-3 (Ed25519 asymmetric link auth) — Backlog

W6-3 was originally framed as "replace the symmetric link PSKs with
Ed25519 keypairs so the DMZ node holds only a public key". After
Phase 6a–6c we re-evaluated and concluded it should remain in the
backlog rather than ship in the W6 cadence:

1. **Symmetric PSK rotation works.** `STRATA_DMZ_LINK_PSKS` accepts a
   comma-separated active-key-set so operators can introduce a new
   PSK alongside the old one, roll backends, then retire the old
   PSK. There is no operational gap forcing asymmetric auth.
2. **The PSKs never traverse the public surface.** They live on the
   DMZ node and the internal node only; both are operator-controlled
   and equivalently trusted. Ed25519 would meaningfully reduce the
   blast radius only if the DMZ host were *less* trusted than the
   internal — but the threat model already treats DMZ compromise as
   "attacker can drop traffic, can't read internal data" (ADR-0009 §
   "what a compromised DMZ node can do"), and that property is
   carried by mTLS + edge-header HMAC, not by the link-authentication
   scheme.
3. **Asymmetric link auth changes the operator surface area.** Key
   generation, key-distribution channel, and the rotation runbook
   would all need new docs and a tested upgrade story. None of that
   is free, and there is no in-flight customer pulling for it.

W6-3 stays open in [threat-model.md](../threat-model.md) §6 with the
status `Backlog` and a pointer to this ADR for the rationale. It will
be revisited if (a) a deployment requires "DMZ host less trusted than
internal host" semantics, or (b) we observe PSK-rotation friction in
operations that the symmetric scheme can't address.

### W6-5

W6-5 ("WS resume across DMZ disconnect") is **deferred** to the WS
session-resume work tracked separately in
[dmz-implementation-plan.md](../dmz-implementation-plan.md) Phase 7.
That phase changes the WebSocket bridge protocol shape (resume
tokens, server-side replay buffer); it does not belong in the W6
hardening pass.

## Consequences

### Positive

- Operators get cert-rotation, body-cap tuning, and verified-edge
  audit attribution without restarting the backend or changing the
  binary contract.
- The DMZ binary now compiles cleanly against axum 0.8 (a pre-existing
  `E0308` in `public_server.rs` was masked by the fact that `cargo
  build` of the DMZ binary is not on the default `docker compose`
  path; Phase 6c surfaced and fixed it).
- The threat-model §6 table now reads four `Resolved` rows + one
  `Backlog` row + one `Deferred` row instead of five `Open` rows;
  prospective deployments asking for a written security posture get
  a single page they can hand to their auditors.

### Negative / costs

- The per-IP body-cap middleware does not stream-cap requests that
  omit `Content-Length` (chunked transfer without a length header).
  Per-route handler limits remain the backstop. We accepted this in
  Phase 6c review because the streaming-cap implementation tripped
  the axum 0.8 `Body` re-injection type and would have doubled the
  diff; the residual is documented in the W6-2 row.
- W6-3 remains formally Open-as-Backlog. We mitigate by recording the
  rationale here and keeping the symmetric-PSK rotation runbook
  current.

### Operational notes

- New env var: `STRATA_DMZ_PUBLIC_BODY_LIMITS_BY_IP`. Format:
  `<cidr>=<bytes>[,<cidr>=<bytes>]*`. Bytes accept `K`/`M`/`G`
  suffixes (1024-base). Bare hosts treated as `/32` (v4) or `/128`
  (v6). Longest-prefix wins. Empty / unset = use the global default
  for every peer.
- New env var: backend `STRATA_DMZ_LINK_CERT_RELOAD_INTERVAL_SECONDS`
  (default 60). Set to `0` to disable the mtime watcher (handshake-
  on-each-reload becomes the only path).
- No migration changes; no schema changes.

## Status by threat-model row (post-Phase 6)

| ID | Status | Closing branch |
|----|--------|-----------------|
| W6-1 | Resolved | `feat/dmz-phase6b-cert-hotreload` |
| W6-2 | Resolved | `feat/dmz-phase6c-per-ip-body-caps` |
| W6-3 | Backlog | this ADR (rationale) |
| W6-4 | Resolved | `feat/dmz-phase6a-audit-enrichment` |
| W6-5 | Deferred to Phase 7 (WS resume) | — |
