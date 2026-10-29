---
name: api-and-rbac-feature
description: 'Implement or modify full-stack features, REST/WebSocket endpoints, authentication flows, and RBAC permissions across the Axum backend (backend/src/) and React 19 SPA (frontend/src/). WHEN: adding or changing /api/* routes, modifying AuthUser/MeResponse, adding RBAC permission checks, updating CSRF/cookie/JWT/OIDC auth, wiring frontend/src/api.ts to backend handlers, or adding Playwright E2E/Vitest/Rust route tests. DO NOT USE FOR: standalone PostgreSQL schema migrations without route/UI changes (use database-migration), low-level protocol wire codecs in crates/strata-session (use session-engine-and-protocol), or cutting a version release (use release-and-documentation-cut).'
---

# Full-Stack API, Auth, and RBAC Feature Workflow

Use this skill when implementing or modifying end-to-end features, HTTP/WebSocket endpoints, authentication flows, or role-based access control (RBAC) across `backend/` and `frontend/`. Follow global policies in [AGENTS.md](../../../AGENTS.md) (§6–§10, §13, §17, §19, §23, §26–§28).

## 1. Discovery and Blast-Radius Analysis

1. **Query Codebase Memory first** (`project: "C-GitRepos-strata-client"`):
   - Use `search_graph` to locate existing handlers in `backend/src/routes/`, business logic in `backend/src/services/`, and client callers in `frontend/src/api.ts`.
   - Use `trace_path` (`direction: "both"`) to trace callers from React components (`frontend/src/pages/`, `frontend/src/components/`) through `frontend/src/api.ts::request` to the Axum route and service layer.
   - Run `check_index_coverage` on candidate files and verify findings against current source files before editing.
2. **Read selective documentation**:
   - Read only the relevant sections of [docs/api-reference.md](../../../docs/api-reference.md), [docs/API-LIFECYCLE.md](../../../docs/API-LIFECYCLE.md), and [docs/security.md](../../../docs/security.md) (especially the RBAC matrix and authentication sections).

## 2. Backend Route, Auth, and RBAC Rules (`backend/src/`)

1. **Router placement (`backend/src/routes/mod.rs`)**:
   - Place routes in the correct router tier (`public`, `authed`, or `admin`).
   - State-changing cookie-authenticated routes (`POST`, `PUT`, `PATCH`, `DELETE`) are gated by `services::middleware::require_csrf` (double-submit `csrf_token` cookie vs `X-CSRF-Token` header) layered before `require_auth`.
   - WebSocket upgrades must validate `Origin` via `services::middleware::check_ws_origin` to prevent CSWSH.
   - File upload routes must apply `upload_limit(UPLOAD_LIMIT_BYTES)` (`RequestBodyLimitLayer` + `DefaultBodyLimit::disable()`).
2. **Boot-phase and granular RBAC guards**:
   - Call `require_running(&state).await?` at the start of handlers that require `BootPhase::Running`.
   - In `admin` handlers, enforce the specific permission helper from `backend/src/services/middleware.rs` (`check_system_permission`, `check_user_management_permission`, `check_connection_management_permission`, `check_audit_permission`, `check_session_permission`, `check_quick_share_permission`, `check_quick_share_outbound_permission`).
   - Preserve established RBAC invariants:
     - Folder access (`role_folders`) is **non-recursive** (`role_folders.folder_id = connections.folder_id`). Never imply or implement subfolder inheritance unless explicitly changing the security model.
     - `can_manage_connections` implies `can_access_all_connections()`.
     - `can_manage_users` permits role assignment (privilege escalation vector); guard any user/role mutation carefully.
3. **`MeResponse` symmetry invariant**:
   - Two endpoints serialise the user identity and permission shape: `backend/src/routes/auth.rs::check_auth` (`GET /api/auth/check`, used on SPA bootstrap) and `backend/src/routes/user.rs::me` (`GET /api/user/me`, used on profile refresh).
   - Any field added to or changed on `MeResponse` **must** be updated in **both** backend handlers and in `frontend/src/api.ts::MeResponse` so initial page loads and in-app refreshes behave identically.
4. **Error handling and API lifecycle (`backend/src/error.rs`)**:
   - Return `Result<..., AppError>`. Map errors to the appropriate `AppError` variant so `error_status_and_message` emits both the human-readable `error` and stable `ErrorCode` (`code` field) per [docs/API-LIFECYCLE.md](../../../docs/API-LIFECYCLE.md). Never leak internal stack traces, SQL errors, or secrets in client responses.
5. **Security and input validation**:
   - Validate untrusted hostnames/URLs at the boundary (e.g., `services::safeguard::client::validate_appliance_host` for outbound requests; CIDR checks against `web_allowed_networks`).
   - Seal secrets through Vault Transit (`vault:` envelope) or the established secret store; never store or return plaintext credentials (`"********"` placeholder on read).
   - Use parameterised `sqlx` queries only. In `OR` filters over large tables, prefer `= ANY(ARRAY(SELECT ...))` over `IN (SELECT ...)` to avoid per-row SubPlan sequential scans.
6. **Hash-chained audit logging (`backend/src/services/audit.rs`)**:
   - Log privileged and security-relevant actions via `services::audit::log(&db.pool, Some(user.id), "category.action", &serde_json::json!({ ... }))`, which invokes `SELECT audit_append($1, $2, $3)` and attaches verified DMZ `_edge` context.

## 3. Frontend Integration Rules (`frontend/src/`)

1. **API client (`frontend/src/api.ts`)**:
   - Route all HTTP calls through `request<T>` (or `xhrUploadJson` for uploads) so `credentials: "include"`, `X-CSRF-Token` injection on mutating methods, and 401 `/api/auth/refresh` retry with Web Locks (`strata-auth-refresh`) work automatically.
   - Never store access or refresh tokens in `localStorage` or `sessionStorage`.
   - When reading `session_expires` cookie, multiply its Unix-epoch-seconds value by `1000` before comparing with `Date.now()`.
2. **UI, state, and accessibility**:
   - Wire components to real backend responses ([AGENTS.md](../../../AGENTS.md) §8–§9); handle loading, empty, and error states without optimistic fake success.
   - Use `ToastProvider` (`frontend/src/components/ToastProvider.tsx`) for notifications and `leaseStore` for credential leases rather than adding redundant polling loops.
   - Satisfy ESLint rules in `frontend/eslint.config.js` (`eslint-plugin-security` errors, `react-hooks`, and `jsx-a11y`).

## 4. Validation

Run the smallest relevant checks first, then expand to match CI (`.github/workflows/ci.yml`):

1. **Frontend checks** (in `frontend/`):
   - `npx tsc --noEmit`
   - `npm run lint`
   - `npm run format:check` (Note: on Windows, never run `prettier --write` on whole directories or root/docs markdown; pass only the modified `frontend/src/...` file paths).
   - `npm run test:coverage` (watch output for Vitest `Unhandled Errors`, which cause exit code 1 even when test assertions pass)
   - `npm run build`
2. **Backend checks** (via Docker when local Cargo is unavailable or blocked on Windows):
   - `cargo fmt -p strata-backend -- --check`
   - `cargo clippy -p strata-backend --all-targets -- -D warnings`
   - `cargo test -p strata-backend --bin strata-backend <filter> -- --test-threads=1` (note: `strata-backend` is a binary crate with no `lib` target).
   - For DB-backed tests, pass `TEST_DATABASE_URL` pointing to a migrated PostgreSQL 16 instance and confirm `SELECT is_called FROM audit_logs_id_seq` returns `t` so tests did not pass by skipping.
3. **End-to-end checks** (`e2e/`):
   - When changing user journeys, auth, or RBAC, add or update Playwright specs under `e2e/tests/`.
   - Ensure total E2E test count stays at or above `E2E_TEST_FLOOR` (`162` in `.github/workflows/ci.yml`); bump `E2E_TEST_FLOOR` when adding new specs.

## 5. Documentation and Completion

- Update [docs/api-reference.md](../../../docs/api-reference.md) for any new or changed endpoint, request/response field, status code, audit event, or environment variable at the time of the change.
- Update [docs/security.md](../../../docs/security.md) or [docs/architecture.md](../../../docs/architecture.md) if auth, RBAC, or data flows changed.
- Report validation results and any unvalidated live-environment behaviour per [AGENTS.md](../../../AGENTS.md) §27–§28.
