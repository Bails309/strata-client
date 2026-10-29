---
name: database-migration
description: 'Author, validate, and troubleshoot PostgreSQL schema migrations (backend/migrations/*.sql) and sqlx database access in backend/src/db/. WHEN: adding a new SQL migration, altering tables/indexes/constraints, modifying Database::migrate or verify_applied_checksums, working with the least-privilege <owner>_runtime database role, or writing DB-backed Rust tests with TEST_DATABASE_URL. DO NOT USE FOR: API or UI changes that do not touch SQL schema or migrations (use api-and-rbac-feature), or general container setup (use container-and-dmz-infrastructure).'
---

# PostgreSQL Schema Migration and Database Workflow

Use this skill when creating or reviewing SQL migrations under `backend/migrations/` or modifying database connection, migration, and role-provisioning logic in `backend/src/db/`. Follow [AGENTS.md](../../../AGENTS.md) (§10, §13, §16, §20, §23).

## 1. Discovery and Inspection

1. **Inspect existing migrations and schema**:
   - Codebase Memory marks several SQL files in `backend/migrations/` as `parse_partial`. Always inspect the relevant `backend/migrations/*.sql` files and `backend/src/db/mod.rs` directly with `read_file` or `grep_search` in addition to `search_graph`.
   - List `backend/migrations/` immediately before creating a file and again before committing (`git status`) to pick the next sequential 3-digit prefix (`NNN_<descriptive_name>.sql`, currently past `103_worker_leases.sql`) and avoid number collisions.
2. **Consult documentation**:
   - Check [docs/runbooks/database-operations.md](../../../docs/runbooks/database-operations.md) and [docs/security.md](../../../docs/security.md) for operational and least-privilege constraints.

## 2. Non-Negotiable Migration Rules

1. **Never edit an already-shipped migration (`SEC-22`)**:
   - Applied migrations are recorded in `_sqlx_migrations` (not `schema_migrations`).
   - `backend/src/db/mod.rs::verify_applied_checksums` verifies the SHA-384 checksum of every applied migration on startup (under advisory lock `0x5354_5241_5441`) and refuses to boot if any file was modified (allowing only LF/CRLF normalisation, historical `KNOWN_EDITS`, or explicit operator override via `STRATA_MIGRATION_REPAIR_VERSIONS`).
   - Always apply schema fixes or follow-up changes in a **new** forward migration file.
2. **Idempotency and legacy upgrade safety**:
   - CI (`.github/workflows/ci.yml` `migrations-check`) runs `sqlx migrate run --source backend/migrations` twice and fails if the second run is not a no-op.
   - Use `IF NOT EXISTS` / `IF EXISTS` guards where appropriate, and never assume objects from historical migration `038` exist without `CREATE TABLE IF NOT EXISTS` (see migration `096_refresh_token_families.sql`).
   - For migrations that build indexes on large tables (such as `audit_logs`), prepend `SET LOCAL statement_timeout = 0;` so the pool's 90 s `DATABASE_STATEMENT_TIMEOUT_MS` does not abort the migration.
3. **Preserve the `audit_logs` hash chain (`SEC-17`)**:
   - Since `098_audit_chain_v2.sql`, `audit_logs` has `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers (`audit_logs_no_change`, `audit_logs_no_truncate`) that raise `insufficient_privilege`, and rows are verified by `services::audit_verify` using `audit_hash_v2`.
   - **Never `INSERT` directly into `audit_logs` from a migration** — direct inserts bypass `audit_append` or break v2 digest continuity. Use `RAISE NOTICE` for migration log messages, or `SELECT audit_append(NULL, 'system.migration', ...)` only if an audit entry is strictly required.
   - Note that the column name is `action_type`, not `action`.
4. **Respect the least-privilege `<owner>_runtime` role (`SEC-25`)**:
   - `Database::migrate` runs as the database owner, after which `Database::into_runtime` reconnects as `<owner>_runtime`.
   - `provision_runtime_role` grants `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` and `USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public`, then explicitly revokes `UPDATE, DELETE, TRUNCATE ON audit_logs, audit_checkpoints` and `INSERT, UPDATE, DELETE, TRUNCATE ON _sqlx_migrations`.
   - Application runtime queries must never issue DDL or attempt to mutate `audit_logs`, `audit_checkpoints`, or `_sqlx_migrations`.
5. **Backwards compatibility and non-destructive changes**:
   - Prefer expand/migrate/contract patterns ([AGENTS.md](../../../AGENTS.md) §20). Give new `NOT NULL` columns safe `DEFAULT` values or backfill existing rows before adding `NOT NULL` constraints.
   - Preserve per-host pins (`host-key`, `host-key-fingerprint`, `sftp-host-key`, `cert-fingerprints`) in `connections.extra` JSONB when writing upserts or data migrations.

## 3. Validation

Validate migrations and database tests using the same commands as `.github/workflows/ci.yml` (`migrations-check` and `backend-check` jobs):

1. **Apply and verify idempotency via `sqlx-cli`**:
   ```sh
   sqlx migrate run --source backend/migrations
   # Second run must output no "Applied" lines:
   sqlx migrate run --source backend/migrations
   ```
2. **Run DB-backed backend tests**:
   ```sh
   TEST_DATABASE_URL=postgres://strata:strata@localhost:5432/strata \
     cargo test -p strata-backend -- --test-threads=1
   ```
   - **Critical**: DB-backed tests silently skip themselves and report `ok` when `TEST_DATABASE_URL` is unset or unreachable. Prove they actually executed by checking a database side effect afterwards:
     ```sh
     psql "$TEST_DATABASE_URL" -tAc "SELECT is_called FROM audit_logs_id_seq"
     # Must output: t
     ```
   - When writing tests that acquire table locks on `audit_logs`, acquire the advisory chain lock (`SELECT pg_advisory_xact_lock(x'5354415544495400'::bigint)`) **first** to prevent deadlocks with concurrent `audit_append` calls.
3. **Formatting and linting**:
   - Ensure the new `.sql` file uses LF line endings (`\n`).
   - Run `cargo fmt -p strata-backend -- --check` and `cargo clippy -p strata-backend --all-targets -- -D warnings`.

## 4. Documentation and Completion

- Update [docs/architecture.md](../../../docs/architecture.md), [docs/security.md](../../../docs/security.md), or [docs/runbooks/database-operations.md](../../../docs/runbooks/database-operations.md) if schema, retention, or operational recovery procedures change.
- Report the migration number, rollback considerations, and verification evidence per [AGENTS.md](../../../AGENTS.md) §27–§28.
