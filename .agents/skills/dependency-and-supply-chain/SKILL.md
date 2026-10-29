---
name: dependency-and-supply-chain
description: 'Upgrade Cargo or npm dependencies, remediate CVE/RUSTSEC/GHSA security advisories, manage vendored Rust forks in crates/vendor/, update CodeQL barrier models, or bump the pinned Rust toolchain. WHEN: running or fixing cargo audit, cargo deny, npm audit, osv-scanner, Trivy, gitleaks, CodeQL, or Dependency Review; updating Cargo.toml/Cargo.lock or package.json/package-lock.json; checking crates/vendor/* with scripts/check-vendored-forks.sh; or bumping the Rust toolchain version across CI and Dockerfiles. DO NOT USE FOR: application feature development without dependency or security-scanner changes (use api-and-rbac-feature).'
---

# Dependency, Advisory Remediation, and Supply-Chain Workflow

Use this skill when upgrading dependencies, triaging or resolving vulnerability/unmaintained advisories, managing `crates/vendor/*` forks, updating CodeQL models, or bumping the Rust toolchain pin. Follow [AGENTS.md](../../../AGENTS.md) (§10, §11, §22, §23).

## 1. Discovery and Policy Grounding

1. **Read current supply-chain configurations**:
   - Inspect [Cargo.toml](../../../Cargo.toml), [deny.toml](../../../deny.toml), [osv-scanner.toml](../../../osv-scanner.toml), [backend/.cargo/audit.toml](../../../backend/.cargo/audit.toml), [.gitleaks.toml](../../../.gitleaks.toml), and [.github/codeql/codeql-config.yml](../../../.github/codeql/codeql-config.yml).
   - Consult [docs/security.md](../../../docs/security.md) (§ Dependency & Supply-Chain Security) and [docs/adr/ADR-0015-native-rust-session-engine.md](../../../docs/adr/ADR-0015-native-rust-session-engine.md) for the handled-advisory ledger and fork rationale.
2. **Use Codebase Memory (`project: "C-GitRepos-strata-client"`)**:
   - Before upgrading or replacing a crate/package or evaluating reachability of a CVE, use `search_graph` and `trace_path` to locate every import and call site across the workspace.

## 2. Ecosystem Constraints and Hard Floors

1. **Rust TLS and crypto policy (`deny.toml`)**:
   - `openssl`, `openssl-sys`, and `native-tls` are **banned** workspace-wide (`deny.toml` `[bans]`). All Rust TLS and crypto must use `rustls` with the `ring` provider (or `aws_lc_rs` for `jsonwebtoken`).
   - Keep `default-features = false` on crates that default to `native-tls`, `openssl`, `aws-lc-rs`, or MySQL (`sqlx`, `reqwest`, `russh`, `ironrdp-tls`, `tokio-tungstenite`, `lettre`).
2. **Mandatory minimum crate floors**:
   - `russh >= 0.65.0` (fixes remote-triggered `CryptoVec` process abort `RUSTSEC-2026-0153`/`0154` and channel/extension DoS advisories; `strata-session` runs in-process in `strata-backend`).
   - `h2 >= 0.4.16` (hard floor for pre-authentication HTTP/2 termination on `strata-dmz`).
   - **Single `ironrdp-svc` version**: Every `ironrdp-*` crate in `crates/strata-session/Cargo.toml` must resolve to the same `ironrdp-svc` version (`0.8`) or trait implementations fail to compile.
3. **DMZ dependency closure (`.github/workflows/dmz-deps.yml`)**:
   - `crates/strata-dmz` must never pull in `sqlx`, `deadpool-postgres`, `vaultrs`, `ldap3`, `krb5`, `kerberos`, `gssapi`, `libgssapi`, `guac*`, or `strata-session`.
4. **Lockfile and container resolution discipline**:
   - Resolve `Cargo.lock` updates inside the pinned Linux container (`rust:1.99-slim-trixie`) rather than a mismatched host Cargo version so platform-specific transitive pins do not drift.
   - In `frontend/` and `e2e/`, update `package-lock.json` via npm and verify `npm ci --legacy-peer-deps` succeeds cleanly in a Linux (`node:24-bookworm`) environment.

## 3. Vendored Forks (`crates/vendor/*`)

The workspace patches three temporary forks via `[patch.crates-io]` in `Cargo.toml`: `ironrdp-connector`, `ironrdp-egfx`, and `sspi`.

1. **Check whether any fork can be dropped**:
   - Run `bash scripts/check-vendored-forks.sh` on every dependency bump and before releases.
   - Note: query `cargo info` from outside the workspace when checking upstream versions, because `[patch.crates-io]` makes Cargo inside the workspace report the local fork.
2. **Four-gate rule when adding or updating `crates/vendor/*`**:
   - Never commit a `Cargo.lock` inside `crates/vendor/*/` (`osv-scanner` scans every lockfile and does not apply root `osv-scanner.toml` to subdirectories).
   - Because path dependencies sit in-repo, check all four path-based CI gates:
     1. **Advisory ignores**: Keep `backend/.cargo/audit.toml` and root `osv-scanner.toml` synchronised with full reachability justifications. Never suppress an advisory without proving in-tree unreachability and documenting when the ignore can be removed.
     2. **Coverage denominator**: Ensure `cargo tarpaulin` in `.github/workflows/ci.yml` excludes `--exclude-files 'crates/vendor/*'` and `--exclude-files 'crates/vendor/**/*'` (never lower the `--fail-under 19` threshold).
     3. **Secrets scan**: If upstream test fixtures contain mock keys/tokens, scope a narrow `paths` allowlist entry in `.gitleaks.toml` with inline justification.
     4. **CodeQL**: Keep `crates/vendor/**` in `paths-ignore` in `.github/codeql/codeql-config.yml`.

## 4. Rust Toolchain Pin Updates

When bumping the Rust version (currently `1.99` / `1.99.0`), all pins must move together in a single change:
1. `.github/workflows/ci.yml` (3 occurrences of `dtolnay/rust-toolchain@<commit-sha> # X.Y.Z`)
2. `.github/workflows/dmz-deps.yml` (2 occurrences of `dtolnay/rust-toolchain@<commit-sha> # X.Y.Z`)
3. `backend/Dockerfile` (`FROM rust:X.Y-slim-trixie@sha256:<digest>`)
4. `crates/strata-dmz/Dockerfile` (`FROM rust:X.Y-bookworm@sha256:<digest>`)
5. `README.md` (Rust badge and requirements), `CONTRIBUTING.md`, and `docs/faq.md`.

## 5. CodeQL Custom Model Pack (`bails309/strata-rust-models`)

- First-party sanitiser barrier models live in `.github/codeql/extensions/strata-rust-models/models/*.model.yml`.
- If a model is added or modified, bump `version` in `.github/codeql/extensions/strata-rust-models/qlpack.yml` and `.github/codeql/codeql-config.yml` (the GHCR registry rejects republishing an existing version via `.github/workflows/codeql-model-pack.yml`).

## 6. Validation (The Eight Supply-Chain Gates)

Run the exact commands used by CI before completing the task:

1. **Rust advisory and license/ban/source checks**:
   ```sh
   (cd backend && cargo audit -f ../Cargo.lock --deny unsound --deny unmaintained)
   cargo deny --all-features check bans licenses sources
   ```
2. **OSV-Scanner (Scorecard `Vulnerabilities` parity)**:
   ```sh
   docker run --rm -v "${PWD}:/src" ghcr.io/google/osv-scanner:latest scan source -r /src
   ```
3. **DMZ dependency closure**:
   ```sh
   cargo tree -p strata-dmz --prefix=none --no-dedupe --edges=normal,build | \
     grep -E '^(sqlx|deadpool-postgres|vaultrs|ldap3|krb5|kerberos|gssapi|libgssapi|guac|strata-session)' && exit 1 || echo "OK"
   ```
4. **Node `npm audit`**:
   ```sh
   npm --prefix frontend audit --audit-level=high --omit=dev
   npm --prefix e2e audit --audit-level=high --omit=dev
   ```
5. **Compile, lint, and test**:
   - Run `cargo clippy --all-targets -- -D warnings` and `cargo test` across `strata-backend`, `strata-session --all-features`, `strata-protocol`, and `strata-dmz`.
   - Run `npm --prefix frontend run test:coverage` and `npm --prefix frontend run build`.
6. **Update documentation**:
   - Record advisory triage and handled-advisory updates in [docs/security.md](../../../docs/security.md).
