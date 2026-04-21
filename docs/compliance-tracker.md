# Coding Standards Compliance Tracker

**Source audit:** 2026-04-21 against Coding Standards v1.4
**Owner:** Platform Engineering
**Status legend:** `[ ]` open · `[~]` in progress · `[x]` done · `[!]` blocked · `[-]` risk-accepted (link to ADR)

Items are grouped into deployment waves. Complete a wave before starting the next — later waves depend on the infrastructure and patterns set up by earlier ones.

---

## Wave 0 — Pre-flight (no code changes, prep only)

- [ ] **W0-1** Create `docs/adrs/` and `docs/runbooks/` directories with README index files (§26, §28)
- [ ] **W0-2** Add `.github/dependabot.yml` covering `cargo`, `npm`, `github-actions`, `docker` ecosystems (§13.2)
- [ ] **W0-3** Confirm `.env`, `*.key`, `*.pem` are in root `.gitignore` (§8.5 / §16.3)
- [ ] **W0-4** Create ADR-0001 capturing the current architecture baseline (Rust+Axum, guacd proxy, Vault Transit, JWT+refresh) so subsequent waves have a known-good reference point

---

## Wave 1 — Supply-chain & release integrity (blocks all prod deploys)

> Goal: every artefact that reaches staging/prod is signed, attested, scanned, and reproducible by commit SHA.

### 1.A — Dependency & image scanning
- [ ] **W1-1** Add `cargo audit` step to CI; fail build on RUSTSEC advisories (§13.2, §18.2) — [.github/workflows/ci.yml](.github/workflows/ci.yml)
- [ ] **W1-2** Add `npm audit --audit-level=high` for `frontend/` and `e2e/` (§13.2)
- [ ] **W1-3** Add `aquasecurity/trivy-action` scan on built images; fail on Critical/High CVEs (§18.2 / §18.3)
- [ ] **W1-4** Add CodeQL (or Semgrep) SAST workflow for JS/TS + Rust (§18.2)

### 1.B — Digest pinning
- [ ] **W1-5** Pin every `FROM` line by `@sha256:` digest — [backend/Dockerfile](backend/Dockerfile)
- [ ] **W1-6** Pin every `FROM` line by `@sha256:` digest — [frontend/Dockerfile](frontend/Dockerfile)
- [ ] **W1-7** Pin every `FROM` line by `@sha256:` digest — [guacd/Dockerfile](guacd/Dockerfile)
- [ ] **W1-8** Replace all floating `image:` tags with `@sha256:` digests — [docker-compose.yml](docker-compose.yml)
- [ ] **W1-9** Enable Renovate `docker.pinDigests: true` (or Dependabot Docker) to auto-refresh the digests

### 1.C — Signing, SBOM, provenance
- [ ] **W1-10** Generate CycloneDX SBOM in CI with `anchore/sbom-action@v0`; upload as artefact; attach to tagged releases (§13.1)
- [ ] **W1-11** Sign published images with Cosign keyless OIDC: `cosign sign --yes <digest>` (§13.7)
- [ ] **W1-12** Attach SBOM as in-toto attestation: `cosign attest --predicate sbom.json --type cyclonedx` (§13.7)
- [ ] **W1-13** Generate SLSA L3 provenance via `slsa-framework/slsa-github-generator` (§13.7)
- [ ] **W1-14** Deploy pipeline runs `cosign verify` + `slsa-verifier verify-image`; rollout blocked on failure (§13.7, §18.2)

---

## Wave 2 — Runtime resilience of shared resources

> Goal: no single slow query, stuck connection, or crashed worker can take the service down.

### 2.A — Database hygiene (§15.4)
- [ ] **W2-1** Add `.acquire_timeout(30s)`, `.idle_timeout(300s)`, `.max_lifetime(3600s)` to `PgPoolOptions` in [backend/src/db/mod.rs](backend/src/db/mod.rs)
- [ ] **W2-2** Add `after_connect` hook issuing `SET statement_timeout = '30s'` (carve out documented batch/analytics sessions separately) — [backend/src/db/mod.rs](backend/src/db/mod.rs)
- [ ] **W2-3** Going-forward rule: new destructive migrations must use `DROP … IF EXISTS` and split across two releases — add PR checklist item

### 2.B — Background workers (§3.3 new sub-rule / §9.6 / §10)
- [ ] **W2-4** Wrap each iteration of the checkout activation worker in `tokio::time::timeout`; add jittered backoff on error — [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs)
- [ ] **W2-5** Same treatment for the session-cleanup loop — [backend/src/main.rs](backend/src/main.rs)
- [ ] **W2-6** Same treatment for `services::health_check` polling loop — [backend/src/services/health_check.rs](backend/src/services/health_check.rs)
- [ ] **W2-7** Introduce a shared `CancellationToken`; collect all spawned `JoinHandle`s; on SIGTERM/SIGINT cancel + `join_all` before exit — [backend/src/main.rs](backend/src/main.rs)
- [ ] **W2-8** Remove every `let _ = sqlx::query(...)` and replace with `?`-propagation or explicit `.map_err(|e| tracing::warn!(...))` — sweep [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs), [backend/src/main.rs](backend/src/main.rs)

### 2.C — Concurrency correctness (§21)
- [ ] **W2-9** Replace the SELECT-then-UPDATE in `activate_checkout` with `SELECT … FOR UPDATE` (or add a `version` column + optimistic CAS) — [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs)
- [ ] **W2-10** Make `retry_checkout_activation` idempotent: accept `Idempotency-Key` header, persist to a new `idempotency_keys` table with TTL, return cached outcome on duplicate — [backend/src/routes/user.rs](backend/src/routes/user.rs) + new migration

---

## Wave 3 — External-call hardening & request-time defence

> Goal: every outbound dependency has bounded latency, retries, and circuit-breaking.

### 3.A — Timeouts & retries (§3.3)
- [ ] **W3-1** Audit every `reqwest::Client::new()` and replace with a shared `Client::builder().timeout(30s).connect_timeout(5s).build()` — hotspots: [backend/src/routes/auth.rs](backend/src/routes/auth.rs), [backend/src/routes/admin/recordings.rs](backend/src/routes/admin/recordings.rs)
- [ ] **W3-2** Add jitter to Vault retry backoff (`delay *= 0.5 + rand(0.5)`) — [backend/src/services/vault.rs](backend/src/services/vault.rs)
- [ ] **W3-3** Add retry-with-jitter wrapper around LDAP operations — [backend/src/services/ad_sync.rs](backend/src/services/ad_sync.rs)
- [ ] **W3-4** Same for keytab / Azure Blob calls
- [ ] **W3-5** Introduce circuit-breaker (e.g. `failsafe` crate) around Vault, LDAP, Azure adapters

### 3.B — Input & abuse surface (§4.1 / §14.3)
- [ ] **W3-6** Magic-number / MIME validation on uploads using `infer` crate — [backend/src/routes/files.rs](backend/src/routes/files.rs)
- [ ] **W3-7** Per-IP + per-target rate limit on `reset_user_password` (3/hour) — [backend/src/routes/admin.rs](backend/src/routes/admin.rs)
- [ ] **W3-8** Decide & document rate-limit distributed-state strategy: either (a) Redis-backed adapter behind feature flag, or (b) ADR risk-accepting single-instance constraint (§14.3)
- [ ] **W3-9** CSRF: either add double-submit token on state-changing POSTs or write ADR accepting SameSite=Strict as compensating control (§4.4)

### 3.C — Audit & logging (§11)
- [ ] **W3-10** Remove the opt-in `STRATA_SHOW_ADMIN_PASSWORD` log branch entirely; keep only the root-only transient-file channel, auto-delete on first read — [backend/src/main.rs](backend/src/main.rs) (§11.3 v1.4)
- [ ] **W3-11** Add `tower-http::trace::TraceLayer` with `MakeRequestUuid`; propagate `X-Request-Id` into outbound `reqwest` calls (§11.5)
- [ ] **W3-12** Expose `/metrics` (Prometheus) behind admin-only network policy; emit RED metrics per endpoint (§11.6)

---

## Wave 4 — Code quality, testing, accessibility

> Goal: keep the codebase maintainable and keep regressions out.

### 4.A — Frontend tooling (§6 / §24)
- [ ] **W4-1** Add `eslint.config.js` with `@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y`, `eslint-plugin-security`; wire to CI — [frontend/](frontend/)
- [ ] **W4-2** Add `.prettierrc` + `.prettierignore`; enforce via husky + lint-staged pre-commit
- [ ] **W4-3** Add `@axe-core/playwright` accessibility assertions to critical e2e journeys — [e2e/](e2e/)

### 4.B — Complexity reduction (§6.3)
- [ ] **W4-4** Split [frontend/src/pages/AdminSettings.tsx](frontend/src/pages/AdminSettings.tsx) (~5000 lines) into sub-tab components under `frontend/src/pages/admin/`
- [ ] **W4-5** Extract the Request-Checkout form and Profile editor from [frontend/src/pages/Credentials.tsx](frontend/src/pages/Credentials.tsx) into child components
- [ ] **W4-6** Move raw SQL out of route handlers into `backend/src/services/*` — hotspots: [backend/src/routes/admin.rs](backend/src/routes/admin.rs), [backend/src/routes/user.rs](backend/src/routes/user.rs) (§3.1)

### 4.C — Test coverage (§12)
- [ ] **W4-7** Backend unit tests to lift coverage toward 80% — prioritise `checkouts.rs`, `vault.rs`, `ad_sync.rs`
- [ ] **W4-8** Add negative/misuse tests: malformed JWT, SQL-like payloads, oversized multipart uploads, rate-limit overflow
- [ ] **W4-9** Frontend negative tests: form validation errors, network failures, 401/403 handling

---

## Wave 5 — Data retention & operational docs

> Goal: close the remaining §25 and §26/§28 gaps.

- [ ] **W5-1** Scheduled task: purge recordings older than `recordings_retention_days` (every 24h) — [backend/src/main.rs](backend/src/main.rs) (§25.2)
- [ ] **W5-2** Scheduled task: hard-delete soft-deleted users after configurable window (default 90 days) — [backend/src/main.rs](backend/src/main.rs) (§25.3)
- [ ] **W5-3** Periodic (hourly) `active_sessions` expiry sweep, not only on startup — [backend/src/main.rs](backend/src/main.rs)
- [ ] **W5-4** Feature-flag system: if gradual rollout / kill switches are needed, introduce `feature_flags` table with `enabled_at`/`expires_at`/`rollout_pct` (§23); otherwise document current boolean-settings design in an ADR
- [ ] **W5-5** Runbook: Disaster Recovery (backup/restore, RTO/RPO) — `docs/runbooks/disaster-recovery.md`
- [ ] **W5-6** Runbook: Security Incident Response — `docs/runbooks/security-incident.md`
- [ ] **W5-7** Runbook: Certificate rotation (ACME + internal CA) — `docs/runbooks/certificate-rotation.md`
- [ ] **W5-8** Runbook: Vault unseal / rekey — `docs/runbooks/vault-operations.md`
- [ ] **W5-9** Runbook: Database failover & migration rollback — `docs/runbooks/database-operations.md`
- [ ] **W5-10** ADR-0002: guacd connection model and security boundaries
- [ ] **W5-11** ADR-0003: JWT + refresh-token session design and rotation rules
- [ ] **W5-12** ADR-0004: Vault Transit envelope encryption for PM credentials
- [ ] **W5-13** ADR-0005: Emergency approval bypass & scheduled-start checkout design

---

## Already compliant ✅ (no action)

Recorded here so nobody re-opens these during review:

- Argon2id password hashing — [backend/src/main.rs](backend/src/main.rs)
- JWT validation (iss/aud/exp, RS256 enforced) — [backend/src/services/auth.rs](backend/src/services/auth.rs)
- Constant-time dummy hash for user-enumeration defence — [backend/src/routes/auth.rs](backend/src/routes/auth.rs)
- Session cookies: `HttpOnly; Secure; SameSite=Strict`
- CORS allow-list (not wildcard) — [backend/src/routes/mod.rs](backend/src/routes/mod.rs)
- UUID resource IDs across all routes
- All SQL parameterised via `sqlx::query!` / `query_as!`
- Resource-ownership checks on delete/revoke endpoints
- Centralised `AppError` → `IntoResponse` — [backend/src/error.rs](backend/src/error.rs)
- Multi-stage Dockerfiles, non-root `USER`, read-only FS on nginx, `no-new-privileges: true`, `cap_drop: ALL`
- Gitleaks secret scan in CI
- Postgres migrations gated by advisory lock (HA-safe) — [backend/src/db/mod.rs](backend/src/db/mod.rs)
- Structured JSON tracing enabled
- Health endpoints public and unauthenticated — [backend/src/routes/health.rs](backend/src/routes/health.rs)

---

## Progress snapshot

| Wave | Open | In progress | Done | Total |
|---|---|---|---|---|
| W0 | 4 | 0 | 0 | 4 |
| W1 | 14 | 0 | 0 | 14 |
| W2 | 10 | 0 | 0 | 10 |
| W3 | 12 | 0 | 0 | 12 |
| W4 | 9 | 0 | 0 | 9 |
| W5 | 13 | 0 | 0 | 13 |
| **Total** | **62** | **0** | **0** | **62** |

Update the table when you tick items so the dashboard reflects reality.
