# ADR-0001: Architecture Baseline

- **Status:** Accepted
- **Date:** 2026-04-21
- **Deciders:** Platform Engineering

## Context

Strata Client is a browser-based privileged access / remote session broker
that has been in active development for multiple releases (current: **0.21.0**).
The Coding Standards v1.4 compliance audit on 2026-04-21 identified 62
follow-up items across six waves (see
[`docs/compliance-tracker.md`](../compliance-tracker.md)). Several of those
waves — notably supply-chain integrity (W1), runtime resilience (W2), and
external-call hardening (W3) — will modify foundational components such as
the database pool, background workers, and HTTP clients.

Before we start changing the baseline, we need a shared snapshot of *what
the baseline is* so that future ADRs (and post-mortems) can reference "the
system as of 0.21.0" unambiguously. Without this ADR, any deviation from
the baseline forces readers to spelunk through git history to work out
*which* architecture was replaced.

## Decision

We will treat **Strata 0.21.0** as the architecture baseline and record it
here, authoritatively. All subsequent ADRs express themselves as *deltas*
against this baseline.

### Baseline components

#### 1. Process topology

Deployed via `docker-compose` as four long-running services:

| Service | Image / source | Role |
|---------|----------------|------|
| `backend` | `backend/Dockerfile` (Rust 1.94, Alpine musl) | Axum HTTP API on port 8080 |
| `frontend` | `frontend/Dockerfile` (nginx:alpine, read-only FS) | Static SPA + TLS termination |
| `guacd` | `guacd/Dockerfile` (custom patch of Apache Guacamole `guacd`) | Protocol proxy for RDP/SSH/VNC |
| `postgres` | `postgres:17-alpine` | Primary data store |

External dependencies reached at runtime:

- **HashiCorp Vault** — Transit engine for envelope-encrypted credentials;
  KV v2 for managed-account password blobs.
- **Active Directory / LDAP** — AD sync, Kerberos keytab auth, managed-account
  password provisioning.
- **SMTP relay** — notification / approval emails.
- **Azure Blob Storage** (optional) — archived recording storage.

#### 2. Request path

```
browser ──TLS──▶ frontend (nginx)
                    │
                    ├── /api/*      ──▶ backend (Axum)
                    │                     │
                    │                     ├── Postgres (sqlx, advisory-locked migrations)
                    │                     ├── Vault   (reqwest, Transit envelope)
                    │                     ├── LDAP/AD (ldap3, Kerberos keytab)
                    │                     ├── SMTP    (lettre)
                    │                     └── Azure Blob (reqwest)
                    │
                    └── /tunnel/*   ──▶ backend (Axum WS) ──▶ guacd (TCP)
```

#### 3. Identity & session model

- **User authentication**: Argon2id-hashed local credentials *or* external
  OIDC, producing a short-lived **JWT access token (RS256, 15 min)** plus a
  rotating **refresh token (30 d sliding)** persisted in
  `active_sessions`.
- **Session cookies**: `HttpOnly; Secure; SameSite=Strict`.
- **JWT validation**: issuer, audience, expiry, and algorithm (RS256)
  enforced server-side on every request.
- **Permission model**: role-based, keyed on columns like
  `can_manage_system`, `can_approve_checkouts`, `can_view_sessions`,
  `is_approver`, `can_self_approve`. Admin routes are gated by a
  `require_admin` middleware layer; some write endpoints are additionally
  gated by `check_system_permission`.
- **Revocation**: `revoked_tokens` table plus pool-level session expiry
  sweep at boot.

#### 4. Data & state

- Postgres is the single source of truth; no other service persists state.
- Migrations live in `backend/migrations/NNN_*.sql`, applied in order at
  backend startup under a Postgres advisory lock (HA-safe).
- Secrets at rest: **Vault Transit** wraps every managed-account password
  and every per-connection credential. Plaintext material never leaves the
  Vault boundary except transiently while the backend injects it into a
  guacd stream.
- `system_settings` is a key/value store for admin-tuneable configuration
  (e.g. `display_timezone`, `roadmap_statuses`, TLS toggles).

#### 5. Background work

Three tokio tasks spawned from `backend/src/main.rs`:

1. **Checkout activation worker** (`services::checkouts`) — polls
   `password_checkout_requests` for due scheduled checkouts / approved
   pending rows, provisions passwords, writes Vault blobs, flips status.
2. **Session cleanup loop** (`main.rs`) — marks orphaned / stale
   `active_sessions` as closed.
3. **Connection health-check poller** (`services::health_check`) — TCP
   probes per connection on a configurable cadence.

All three currently lack explicit per-iteration timeouts, jittered backoff,
and shutdown coordination — these are tracked under compliance wave W2.

#### 6. Recording pipeline

- guacd is instructed, per-session, to write a `.guac` recording to a
  mounted volume.
- A post-session converter produces the playback asset; retention is
  governed by `recordings_retention_days` in `system_settings`.
- Optional off-box archival via Azure Blob.

#### 7. CI & release

- GitHub Actions workflows: `ci.yml` (lint/test/build) and
  `build-guacd.yml` (custom guacd image).
- Gitleaks secret scan runs in CI.
- **Not yet in place** (tracked under W1): `cargo audit`, `npm audit`,
  Trivy, CodeQL, SBOM, Cosign signing, SLSA provenance, Dependabot (added
  in this same change as part of W0-2).

#### 8. Observability

- Structured JSON tracing via `tracing` + `tracing-subscriber`.
- Health endpoints `/api/health`, `/api/ready` are public and
  unauthenticated.
- No Prometheus metrics endpoint or request-id middleware yet (tracked
  under W3-11 / W3-12).

### Baseline invariants that must not regress

Future ADRs **must** explicitly call out if they modify any of:

1. JWT algorithm (RS256), access-token TTL (15 min), or refresh-token
   rotation semantics.
2. Argon2id as the local-password KDF.
3. Vault Transit as the envelope-encryption provider for credentials at rest.
4. Postgres as the single system-of-record.
5. Migration model: ordered, advisory-locked, idempotent.
6. Cookie attributes: `HttpOnly; Secure; SameSite=Strict`.
7. Parameterised SQL throughout (no string-interpolation query construction).

Any deviation requires a superseding ADR; silent divergence is a compliance
failure.

## Consequences

**Positive**

- Future ADRs can cite "baseline: ADR-0001" instead of re-describing the
  system each time.
- Compliance tracker items have a stable reference point for the
  *before* state.
- Onboarding engineers have a one-page map of the runtime topology.

**Negative**

- This ADR will partially age as waves W1-W5 land; we accept that because
  each of those waves will produce its own ADR amending the baseline in a
  named area (supply-chain, background workers, etc.).

**Neutral**

- No code change; this is a documentation-only decision.

## Alternatives considered

1. **Embed the baseline description inside `docs/architecture.md`.**
   Rejected: `architecture.md` is a living document that we rewrite as the
   system evolves. Compliance ADRs need a stable, immutable snapshot they
   can cite.
2. **Skip ADR-0001 and start from ADR-0002.** Rejected: every subsequent
   ADR would need to forward-reference an unwritten baseline, creating
   ambiguous "the old way" language in PR reviews.
3. **One ADR per subsystem.** Rejected for *baseline* purposes — a single
   snapshot is easier to diff against. Subsystem-specific ADRs will still
   be written (W5-10 through W5-13) to capture the *rationale* for the
   design choices, not just their existence.

## Related

- [../architecture.md](../architecture.md) — current (evolving) architecture overview
- [../security.md](../security.md) — security posture reference
- [../compliance-tracker.md](../compliance-tracker.md) — compliance follow-up waves
- Planned: ADR-0002 (guacd connection model), ADR-0003 (JWT + refresh
  design), ADR-0004 (Vault Transit envelope), ADR-0005 (emergency bypass &
  scheduled-start checkouts)
