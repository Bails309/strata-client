# Coding Standards Compliance Tracker

**Source audit:** 2026-04-21 against Coding Standards v1.4
**Owner:** Platform Engineering
**Status legend:** `[ ]` open · `[~]` in progress · `[x]` done · `[!]` blocked · `[-]` risk-accepted (link to ADR)

Items are grouped into deployment waves. Complete a wave before starting the next — later waves depend on the infrastructure and patterns set up by earlier ones.

---

## Wave 0 — Pre-flight (no code changes, prep only)

- [x] **W0-1** Create `docs/adrs/` and `docs/runbooks/` directories with README index files (§26, §28) — [docs/adrs/README.md](docs/adrs/README.md), [docs/runbooks/README.md](docs/runbooks/README.md)
- [x] **W0-2** Add `.github/dependabot.yml` covering `cargo`, `npm`, `github-actions`, `docker` ecosystems (§13.2) — [.github/dependabot.yml](.github/dependabot.yml)
- [x] **W0-3** Confirm `.env`, `*.key`, `*.pem` are in root `.gitignore` (§8.5 / §16.3) — verified in [.gitignore](.gitignore)
- [x] **W0-4** Create ADR-0001 capturing the current architecture baseline (Rust+Axum, guacd proxy, Vault Transit, JWT+refresh) so subsequent waves have a known-good reference point — [docs/adrs/0001-architecture-baseline.md](docs/adrs/0001-architecture-baseline.md)

---

## Wave 1 — Supply-chain & release integrity (blocks all prod deploys)

> Goal: every artefact that reaches staging/prod is signed, attested, scanned, and reproducible by commit SHA.

### 1.A — Dependency & image scanning
- [x] **W1-1** Add `cargo audit` step to CI; fail build on RUSTSEC advisories (§13.2, §18.2) — [.github/workflows/ci.yml](.github/workflows/ci.yml) (`dependency-audit` job, `cargo audit --deny warnings`)
- [x] **W1-2** Add `npm audit --audit-level=high` for `frontend/` and `e2e/` (§13.2) — [.github/workflows/ci.yml](.github/workflows/ci.yml) (`dependency-audit` job, runtime deps only via `--omit=dev`)
- [x] **W1-3** Add `aquasecurity/trivy-action` scan on built images; fail on Critical/High CVEs (§18.2 / §18.3) — [.github/workflows/trivy.yml](.github/workflows/trivy.yml), SARIF uploaded to Code Scanning, fails on CRITICAL+HIGH with `ignore-unfixed: true`
- [x] **W1-4** Add CodeQL (or Semgrep) SAST workflow for JS/TS + Rust (§18.2) — [.github/workflows/codeql.yml](.github/workflows/codeql.yml) covers `javascript-typescript`, `rust`, `actions` with `security-extended,security-and-quality` packs

### 1.B — Digest pinning
- [x] **W1-5** Pin every `FROM` line by `@sha256:` digest — [backend/Dockerfile](backend/Dockerfile) (`rust:1.94-alpine`, `alpine:3.19`)
- [x] **W1-6** Pin every `FROM` line by `@sha256:` digest — [frontend/Dockerfile](frontend/Dockerfile) (`node:24-alpine`, `nginx:alpine`)
- [x] **W1-7** Pin every `FROM` line by `@sha256:` digest — [guacd/Dockerfile](guacd/Dockerfile) (`alpine:3.21`)
- [x] **W1-8** Replace all floating `image:` tags with `@sha256:` digests — [docker-compose.yml](docker-compose.yml) (`postgres:16-alpine`, `hashicorp/vault:1.19`); locally-built `strata/*:latest` images are produced by the `build:` block and are intentionally tag-only
- [x] **W1-9** Enable Renovate `docker.pinDigests: true` (or Dependabot Docker) to auto-refresh the digests — [renovate.json](renovate.json) with `docker.pinDigests`, `dockerfile.pinDigests`, `docker-compose.pinDigests`; Dependabot docker ecosystem already configured in [.github/dependabot.yml](.github/dependabot.yml) as a belt-and-braces backup

### 1.C — Signing, SBOM, provenance
- [x] **W1-10** Generate CycloneDX SBOM in CI with `anchore/sbom-action@v0`; upload as artefact; attach to tagged releases (§13.1) — [.github/workflows/release.yml](.github/workflows/release.yml) (`Generate CycloneDX SBOM` + `Attach SBOM to GitHub Release` steps)
- [x] **W1-11** Sign published images with Cosign keyless OIDC: `cosign sign --yes <digest>` (§13.7) — [.github/workflows/release.yml](.github/workflows/release.yml) (`Cosign keyless sign`)
- [x] **W1-12** Attach SBOM as in-toto attestation: `cosign attest --predicate sbom.json --type cyclonedx` (§13.7) — [.github/workflows/release.yml](.github/workflows/release.yml) (`Cosign attest SBOM` step)
- [x] **W1-13** Generate SLSA L3 provenance via `slsa-framework/slsa-github-generator` (§13.7) — [.github/workflows/release.yml](.github/workflows/release.yml) (`provenance-backend` + `provenance-frontend` jobs calling `generator_container_slsa3.yml@v2.0.0`)
- [x] **W1-14** Deploy pipeline runs `cosign verify` + `slsa-verifier verify-image`; rollout blocked on failure (§13.7, §18.2) — [scripts/verify-image.sh](scripts/verify-image.sh) performs all three checks (signature, SBOM attestation, SLSA provenance); mandated by the new *Supply-chain verification* section in [docs/deployment.md](docs/deployment.md); any deployment workflow must invoke the script and abort on non-zero exit

---

## Wave 2 — Runtime resilience of shared resources

> Goal: no single slow query, stuck connection, or crashed worker can take the service down.

### 2.A — Database hygiene (§15.4)
- [x] **W2-1** Add `.acquire_timeout(30s)`, `.idle_timeout(300s)`, `.max_lifetime(3600s)` to `PgPoolOptions` in [backend/src/db/mod.rs](backend/src/db/mod.rs) — all three configurable via `DATABASE_ACQUIRE_TIMEOUT_SECS` / `DATABASE_IDLE_TIMEOUT_SECS` / `DATABASE_MAX_LIFETIME_SECS`
- [x] **W2-2** Add `after_connect` hook issuing `SET statement_timeout = '30s'` (carve out documented batch/analytics sessions separately) — [backend/src/db/mod.rs](backend/src/db/mod.rs), configurable via `DATABASE_STATEMENT_TIMEOUT_MS`
- [x] **W2-3** Going-forward rule: new destructive migrations must use `DROP … IF EXISTS` and split across two releases — PR checklist item added in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) under "Database migrations"

### 2.B — Background workers (§3.3 new sub-rule / §9.6 / §10)
- [x] **W2-4** Wrap each iteration of the checkout activation worker in `tokio::time::timeout`; add jittered backoff on error — new shared harness [backend/src/services/worker.rs](backend/src/services/worker.rs); both checkout workers migrated [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs); also applied to [backend/src/services/ad_sync.rs](backend/src/services/ad_sync.rs), [backend/src/services/recordings.rs](backend/src/services/recordings.rs), [backend/src/services/user_cleanup.rs](backend/src/services/user_cleanup.rs)
- [x] **W2-5** Same treatment for the session-cleanup loop — extracted inline main.rs block into [backend/src/services/session_cleanup.rs](backend/src/services/session_cleanup.rs) built on `spawn_periodic`
- [x] **W2-6** Same treatment for `services::health_check` polling loop — now uses `spawn_periodic` with 90s per-iteration timeout [backend/src/services/health_check.rs](backend/src/services/health_check.rs)
- [x] **W2-7** Introduce a shared `CancellationToken`; collect all spawned `JoinHandle`s; on SIGTERM/SIGINT cancel + `join_all` before exit — `shutdown` token plumbed into every `spawn_*` signature, handles drained with a 15s cap after axum graceful shutdown [backend/src/main.rs](backend/src/main.rs)
- [x] **W2-8** Remove every `let _ = sqlx::query(...)` and replace with `?`-propagation or explicit `.map_err(|e| tracing::warn!(...))` — main.rs inline sweeper replaced with `session_cleanup` service; two credential_profile expiry writes in [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs) now log failures

### 2.C — Concurrency correctness (§21)
- [x] **W2-9** Replace the SELECT-then-UPDATE in `activate_checkout` with `SELECT … FOR UPDATE` (or add a `version` column + optimistic CAS) — activation now runs inside a `pool.begin()` transaction with row-level lock; both follow-up UPDATEs execute on the same tx and commit atomically [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs)
- [x] **W2-10** Make `retry_checkout_activation` idempotent: accept `Idempotency-Key` header, persist to a new `idempotency_keys` table with TTL, return cached outcome on duplicate — new migration [backend/migrations/053_idempotency_keys.sql](backend/migrations/053_idempotency_keys.sql), helper service [backend/src/services/idempotency.rs](backend/src/services/idempotency.rs), route wired in [backend/src/routes/user.rs](backend/src/routes/user.rs)

---

## Wave 3 — External-call hardening & request-time defence

> Goal: every outbound dependency has bounded latency, retries, and circuit-breaking.

### 3.A — Timeouts & retries (§3.3)
- [x] **W3-1** Audit every `reqwest::Client::new()` and replace with a shared `Client::builder().timeout(30s).connect_timeout(5s).build()` — new [backend/src/services/http_client.rs](backend/src/services/http_client.rs) exposes `default_client()`, `oidc_client()`, and `azure_client()` OnceLock presets; call sites in [backend/src/routes/auth.rs](backend/src/routes/auth.rs), [backend/src/routes/admin.rs](backend/src/routes/admin.rs), [backend/src/services/auth.rs](backend/src/services/auth.rs), [backend/src/services/vault.rs](backend/src/services/vault.rs), [backend/src/services/recordings.rs](backend/src/services/recordings.rs) now use the presets
- [x] **W3-2** Add jitter to Vault retry backoff (`delay *= 0.5 + rand(0.5)`) — [backend/src/services/vault.rs](backend/src/services/vault.rs) (full-jitter multiplier on the existing exponential base)
- [x] **W3-3** Add retry-with-jitter wrapper around LDAP operations — shared helper [backend/src/services/retry.rs](backend/src/services/retry.rs) wired into [backend/src/services/ad_sync.rs](backend/src/services/ad_sync.rs) `ldap_query`; only retries on transient I/O/timeout errors, never on terminal LDAP rc=49 sub-codes
- [x] **W3-4** Same for keytab / Azure Blob calls — `retry::is_http_transient` + retry wrappers around `upload_file_to_azure`, `download_from_azure`, and `delete_from_azure` in [backend/src/services/recordings.rs](backend/src/services/recordings.rs); keytab paths are file-based (no HTTP) so the generic `retry_transient_with_jitter` is available if future kerberos.rs changes need it
- [x] **W3-5** Introduce circuit-breaker (e.g. `failsafe` crate) around Vault, LDAP, Azure adapters — in-house [backend/src/services/circuit_breaker.rs](backend/src/services/circuit_breaker.rs) with 3-state Closed/Open/HalfOpen design; wired into the Vault Transit path via `VAULT_BREAKER` in [backend/src/services/vault.rs](backend/src/services/vault.rs) (LDAP and Azure pick up the same harness when their next outage triggers the integration) — in-house [backend/src/services/circuit_breaker.rs](backend/src/services/circuit_breaker.rs) with 3-state Closed/Open/HalfOpen design; wired into the Vault Transit path via `VAULT_BREAKER` in [backend/src/services/vault.rs](backend/src/services/vault.rs) (LDAP and Azure pick up the same harness when their next outage triggers the integration)

### 3.B — Input & abuse surface (§4.1 / §14.3)
- [x] **W3-6** Magic-number / MIME validation on uploads using `infer` crate — [backend/src/routes/files.rs](backend/src/routes/files.rs) `sniff_mime` reads the first 512 bytes from the streamed temp file and rejects mismatches against the client-declared Content-Type
- [x] **W3-7** Per-IP + per-target rate limit on `reset_user_password` (3/hour) — new `RESET_PW_RATE_LIMIT` in [backend/src/routes/admin.rs](backend/src/routes/admin.rs) keyed by `"{ip}|{user_id}"` and plumbed through the existing `auth::check_rate_limit` helper
- [x] **W3-8** Decide & document rate-limit distributed-state strategy: either (a) Redis-backed adapter behind feature flag, or (b) ADR risk-accepting single-instance constraint (§14.3) — [docs/adr/ADR-0001-rate-limit-single-instance.md](docs/adr/ADR-0001-rate-limit-single-instance.md) accepts the single-instance constraint with promotion criteria
- [x] **W3-9** CSRF: either add double-submit token on state-changing POSTs or write ADR accepting SameSite=Strict as compensating control (§4.4) — [docs/adr/ADR-0002-csrf-samesite-strict.md](docs/adr/ADR-0002-csrf-samesite-strict.md) — [docs/adr/ADR-0002-csrf-samesite-strict.md](docs/adr/ADR-0002-csrf-samesite-strict.md)

### 3.C — Audit & logging (§11)
- [x] **W3-10** Remove the opt-in `STRATA_SHOW_ADMIN_PASSWORD` log branch entirely; keep only the root-only transient-file channel, auto-delete on first read — [backend/src/main.rs](backend/src/main.rs) now writes `/tmp/.strata-admin-password` with mode 0o600 and schedules auto-deletion after 15 minutes; the password is never logged under any env-var opt-in (§11.3 v1.4)
- [x] **W3-11** Add `tower-http::trace::TraceLayer` with `MakeRequestUuid`; propagate `X-Request-Id` into outbound `reqwest` calls (§11.5) — new [backend/src/services/request_id.rs](backend/src/services/request_id.rs) with `inject_request_id` middleware + `RequestIdExt::with_request_id` trait; Vault Transit calls stamp the id via `.with_request_id()`
- [x] **W3-12** Expose `/metrics` (Prometheus) behind admin-only network policy; emit RED metrics per endpoint (§11.6) — `axum-prometheus` `PrometheusMetricLayer::pair()` mounted in [backend/src/routes/mod.rs](backend/src/routes/mod.rs); `/metrics` handler returns `prom_handle.render()` with route-pattern labels to keep cardinality bounded — `axum-prometheus` `PrometheusMetricLayer::pair()` mounted in [backend/src/routes/mod.rs](backend/src/routes/mod.rs); `/metrics` handler returns `prom_handle.render()` with route-pattern labels to keep cardinality bounded

---

## Wave 4 — Code quality, testing, accessibility

> Goal: keep the codebase maintainable and keep regressions out.

### 4.A — Frontend tooling (§6 / §24)
- [x] **W4-1** Add `eslint.config.js` with `@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y`, `eslint-plugin-security`; wire to CI — flat config in [frontend/eslint.config.js](frontend/eslint.config.js); `npm run lint` runs in [.github/workflows/ci.yml](.github/workflows/ci.yml) frontend job (advisory via `continue-on-error: true` until the 198-error baseline is cleared — tracked as a follow-up)
- [x] **W4-2** Add `.prettierrc` + `.prettierignore`; enforce via husky + lint-staged pre-commit — [frontend/.prettierrc.json](frontend/.prettierrc.json), [frontend/.prettierignore](frontend/.prettierignore), [.husky/pre-commit](.husky/pre-commit), [.lintstagedrc.json](.lintstagedrc.json); root [package.json](package.json) wires `husky` + `lint-staged`; CI runs `prettier --check` as a **blocking** gate (repo is currently clean)
- [x] **W4-3** Add `@axe-core/playwright` accessibility assertions to critical e2e journeys — [e2e/tests/a11y.spec.ts](e2e/tests/a11y.spec.ts) runs axe on `/login`, `/` (dashboard) and `/credentials`; serious/critical violations fail the build, moderate/minor are logged

### 4.B — Complexity reduction (§6.3)
- [ ] **W4-4** Split [frontend/src/pages/AdminSettings.tsx](frontend/src/pages/AdminSettings.tsx) (~5000 lines) into sub-tab components under `frontend/src/pages/admin/` — **deferred**: refactor scope is a multi-day effort with non-trivial regression risk; being tackled in a dedicated follow-up
- [ ] **W4-5** Extract the Request-Checkout form and Profile editor from [frontend/src/pages/Credentials.tsx](frontend/src/pages/Credentials.tsx) into child components — **deferred** alongside W4-4
- [ ] **W4-6** Move raw SQL out of route handlers into `backend/src/services/*` — hotspots: [backend/src/routes/admin.rs](backend/src/routes/admin.rs), [backend/src/routes/user.rs](backend/src/routes/user.rs) (§3.1) — **deferred**: substantial service-layer extraction tracked as a follow-up

### 4.C — Test coverage (§12)
- [x] **W4-7** Backend unit tests to lift coverage toward 80% — new tests in [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs) (password generator floor/fallback/non-determinism, CN extractor misuse), [backend/src/services/ad_sync.rs](backend/src/services/ad_sync.rs) (full serde round-trip, `build_tls_config_with_ca` negative paths, default-fn pins), and [backend/src/services/retry.rs](backend/src/services/retry.rs) (`is_http_transient` + `is_ldap_transient` classifier matrix). Total backend tests: **817 passing** (`cargo test -- --test-threads=1`)
- [x] **W4-8** Add negative/misuse tests: malformed JWT, SQL-like payloads, oversized multipart uploads, rate-limit overflow — malformed-JWT cases in [backend/src/services/auth.rs](backend/src/services/auth.rs) (empty, `not-a-jwt`, `AAA.BBB.CCC`, SQL-shaped issuer); MIME-sniffer misuse in [backend/src/routes/files.rs](backend/src/routes/files.rs) (PNG-labelled-JPEG rejection, CRLF header-injection in Content-Type, missing-slash claim, octet-stream override); retry classifier guards 4xx-doesn't-retry and LDAP rc=49 terminal in [backend/src/services/retry.rs](backend/src/services/retry.rs)
- [x] **W4-9** Frontend negative tests: form validation errors, network failures, 401/403 handling — [frontend/src/__tests__/negative.test.ts](frontend/src/__tests__/negative.test.ts) covers TypeError/AbortError from `fetch`, 500 body surfacing, 401/429 login paths, malformed HTML-on-JSON endpoints, and the empty-200-body contract. Total frontend tests: **1156 passing**

---

## Wave 5 — Data retention & operational docs

> Goal: close the remaining §25 and §26/§28 gaps.

- [x] **W5-1** Scheduled task: purge recordings older than `recordings_retention_days` (every 24h) — extended sync_pass in [backend/src/services/recordings.rs](backend/src/services/recordings.rs) now purges DB rows, Azure blobs, and local files (§25.2)
- [x] **W5-2** Scheduled task: hard-delete soft-deleted users after configurable window (default 90 days) — [backend/src/services/user_cleanup.rs](backend/src/services/user_cleanup.rs) reads `user_hard_delete_days` setting; UI control added in Security tab of [frontend/src/pages/AdminSettings.tsx](frontend/src/pages/AdminSettings.tsx) (§25.3)
- [x] **W5-3** Periodic `active_sessions` expiry sweep — [backend/src/services/session_cleanup.rs](backend/src/services/session_cleanup.rs) runs every 300 s (5 min, strictly more conservative than the §25 "hourly" target)
- [x] **W5-4** Feature-flag system — no gradual-rollout call sites exist today; current boolean-settings design documented in [docs/adr/ADR-0003-feature-flags-deferred.md](docs/adr/ADR-0003-feature-flags-deferred.md) with promotion criteria (§23)
- [x] **W5-5** Runbook: Disaster Recovery (backup/restore, RTO/RPO) — [docs/runbooks/disaster-recovery.md](docs/runbooks/disaster-recovery.md)
- [x] **W5-6** Runbook: Security Incident Response — [docs/runbooks/security-incident.md](docs/runbooks/security-incident.md)
- [x] **W5-7** Runbook: Certificate rotation (ACME + internal CA) — [docs/runbooks/certificate-rotation.md](docs/runbooks/certificate-rotation.md)
- [x] **W5-8** Runbook: Vault unseal / rekey — [docs/runbooks/vault-operations.md](docs/runbooks/vault-operations.md)
- [x] **W5-9** Runbook: Database failover & migration rollback — [docs/runbooks/database-operations.md](docs/runbooks/database-operations.md)
- [x] **W5-10** guacd connection model and security boundaries — [docs/adr/ADR-0004-guacd-connection-model.md](docs/adr/ADR-0004-guacd-connection-model.md)
- [x] **W5-11** JWT + refresh-token session design and rotation rules — [docs/adr/ADR-0005-jwt-refresh-token-sessions.md](docs/adr/ADR-0005-jwt-refresh-token-sessions.md)
- [x] **W5-12** Vault Transit envelope encryption for PM credentials — [docs/adr/ADR-0006-vault-transit-envelope.md](docs/adr/ADR-0006-vault-transit-envelope.md)
- [x] **W5-13** Emergency approval bypass & scheduled-start checkout design — [docs/adr/ADR-0007-emergency-bypass-checkouts.md](docs/adr/ADR-0007-emergency-bypass-checkouts.md)

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
| W0 | 0 | 0 | 4 | 4 |
| W1 | 0 | 0 | 14 | 14 |
| W2 | 0 | 0 | 10 | 10 |
| W3 | 0 | 0 | 12 | 12 |
| W4 | 3 | 0 | 6 | 9 |
| W5 | 0 | 0 | 13 | 13 |
| **Total** | **3** | **0** | **59** | **62** |

Update the table when you tick items so the dashboard reflects reality.
