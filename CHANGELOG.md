# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.2] — 2026-04-15

### Fixed
- **NVR Observe WebSocket Auth Failure**: The NVR live-session observer WebSocket could fail silently when the access token had expired, since WebSocket connections cannot use the normal 401-retry interceptor. The `buildNvrObserveUrl` helper now calls `ensureFreshToken()` to silently refresh the token before embedding it in the URL. If no valid token is available, the player shows a clear "Session expired" message instead of a generic failure.
- **`can_view_sessions` Missing from Auth Check**: The `GET /api/auth/check` endpoint (used on page load to hydrate the user) was missing `can_view_sessions` from its SQL query and JSON response. Users whose role had only the "View own sessions" permission could not see the Sessions sidebar link because the field was `undefined`.
- **NVR Player Error UX**: Improved error messages for common WebSocket failure codes (session not found, auth failure). Added a Retry button in the error banner so users don't have to navigate away and back.

### Changed
- **NVR Observe Route Guard**: The `/observe/:sessionId` route now requires `can_manage_system` or `can_view_audit_logs`, matching the permissions needed to see the Live/Rewind buttons on the Sessions page.

## [0.14.1] — 2026-04-15

### Added
- **Expired Credential Renewal at Connect Time**: When a user connects to a session with an expired credential profile, the pre-connect prompt now shows the expired profile with an "Update & Connect" form. Users can enter new credentials to renew the profile and connect immediately, or dismiss the form and enter manual one-time credentials instead.
- **Connection Info — Expired Profile Metadata**: The `GET /api/user/connections/:id/info` endpoint now returns an `expired_profile` object (`id`, `label`, `ttl_hours`) when the connection has a mapped credential profile that has expired, enabling the frontend to offer in-line renewal.

### Fixed
- **Popout Window Clipboard (Server → Local)**: Copying text inside a remote session in a pop-out window now correctly writes to the local clipboard. Previously, the `client.onclipboard` handler always used the main window's `navigator.clipboard`, which was denied by the browser because the main window lacked focus. The handler now uses the popup window's `navigator.clipboard` when the session is popped out.

## [0.14.0] — 2026-04-15

### Added
- **Unified Sessions Page**: New dedicated `/sessions` sidebar page combining live session monitoring and recording history into a single tabbed interface. Replaces the old admin-only Active Sessions panel and the standalone My Recordings page.
- **Role-Based Session Access (`can_view_sessions`)**: New permission column on the roles table (`033_can_view_sessions.sql`). Users with this permission see only their own live sessions and recordings. Users with `can_manage_system` or `can_view_audit_logs` get the full admin view — all users' sessions with kill, observe, and rewind controls.
- **User Sessions API (`GET /api/user/sessions`)**: New authenticated endpoint returning only the calling user's active sessions, filtered from the in-memory `SessionRegistry`.
- **User Recordings API (`GET /api/user/recordings`)**: New authenticated endpoint returning only the calling user's historical recordings with optional connection and pagination filters.
- **User Recording Playback (`GET /api/user/recordings/:id/stream`)**: New endpoint for streaming a user's own recording for playback.
- **Admin Role Form — Sessions Permission**: The "View own sessions" (`can_view_sessions`) toggle is now available in the role create/edit form under Admin → Access, with a "Sessions" badge on the role table.

### Changed
- **Sidebar Navigation**: Replaced the separate "Live Sessions" (admin) and "Recordings" entries with a single "Sessions" item, gated by `can_view_sessions || can_manage_system || can_view_audit_logs`.
- **Admin Settings — Sessions Tab**: Removed the embedded live sessions table and recording history from the Sessions tab. The tab now only contains session analytics (stats, charts, leaderboards, guacd capacity gauge). Live/recording management has moved to the dedicated `/sessions` page.
- **MeResponse & LoginResponse**: Both API responses now include `can_view_sessions` in the user object.

### Removed
- **ActiveSessions standalone route**: The `/admin/sessions` route has been removed in favor of the unified `/sessions` page.

## [0.13.2] — 2026-04-15

### Added
- **In-App Documentation Page**: New `/docs` page accessible from the sidebar with left-nav navigation, rendering Architecture, Security, and API Reference markdown docs inline, plus a What's New tab powered by the release card carousel.
- **Full Release History**: The What's New carousel now covers every release from v0.13.2 back to v0.1.0 (24 cards total), including all previously-missing patch versions (0.10.1–0.10.6, 0.11.1–0.11.2, 0.9.0, and all pre-0.8.0 releases).

### Fixed
- **Session Idle Timeout**: Active users were logged out after 20 minutes even while actively using remote sessions (e.g., clicking, typing in RDP/VNC). The access token now proactively refreshes in the background when user activity is detected and the token is past its halfway point, with a 30-second cooldown between refresh attempts.
- **Backend Clippy (CI)**: Added missing `watermark` field to five test struct initialisers in `admin.rs` and `user.rs` that were missed when the per-connection watermark feature was added in 0.13.0.

### Changed
- **Docs Page Scope**: Removed Deployment Guide and Ubuntu VM Deployment Guide from the in-app docs page — these are GitHub-only documentation files.

## [0.13.1] — 2026-04-15

### Added
- **What's New Carousel**: The What's New modal now lets users browse all previous release cards with left/right navigation arrows and a page counter, instead of only showing the latest release.

### Fixed
- **guacd Scaling (docker-compose)**: The `GUACD_INSTANCES` environment variable was defined in `.env` but never forwarded into the backend container, causing it to always see a single-instance pool. The variable is now passed through in `docker-compose.yml`.

### Changed
- **Architecture Documentation**: Removed all stale Caddy reverse proxy references. Updated to reflect the current nginx-based gateway architecture including SSL termination, reverse proxying, security headers, and the split config files (`common.fragment`, `http_only.conf`, `https_enabled.conf`). Updated migration references through `032_connection_watermark.sql`.

## [0.13.0] — 2026-04-15

### Added
- **Per-Connection Watermark**: Connections now have a `watermark` setting (`inherit`, `on`, `off`) that overrides the global watermark toggle. Configurable in the connection editor form. New migration `032_connection_watermark`.
- **Persistent Favorites Filter**: The dashboard favorites toggle now persists across sessions via `localStorage`, so returning users see their preferred filter state.

### Fixed
- **Clipboard in Popout Windows**: Pasting text copied after a session was popped out now works correctly. The popout window registers its own clipboard sync handlers (`paste` event + Clipboard API on focus/mousedown) so the remote session always receives the latest clipboard content.

## [0.12.0] — 2026-04-14

### Added
- **Password Policy Enforcement**: New passwords must be at least 12 characters. Validation applied on user creation and password change. Passwords over 1024 characters are rejected to prevent abuse.
- **Password Change Endpoint**: Users can change their own password via `PUT /api/auth/password`. Requires current password verification. Revokes the active session on success, forcing re-login.
- **Admin Password Reset**: Admins can force-reset any user's password via `POST /api/admin/users/:id/reset-password`, generating a new random 16-character password returned once.
- **Access + Refresh Token Architecture**: Authentication now uses short-lived access tokens (20 minutes) with a longer-lived refresh token (8 hours) delivered as an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. This replaces the previous single 24-hour JWT, aligning with OWASP session timeout guidance.
- **Token Refresh Endpoint**: `POST /api/auth/refresh` exchanges a valid refresh cookie for a fresh access token without requiring re-authentication.
- **Silent Token Refresh**: The frontend API client automatically refreshes expired access tokens on 401 responses, with deduplication to prevent concurrent refresh storms.
- **Session Timeout Warning Toast**: A floating notification appears in the bottom-right corner 2 minutes before the access token expires, showing a live `m:ss` countdown with **Extend Session** (triggers refresh) and **Dismiss** buttons.
- **Per-User Session Tracking**: New `active_sessions` database table records each login with JTI, user ID, IP address, user agent, and expiry time — providing visibility into active authentication sessions.

### Changed
- **JWT Claims**: Access and refresh tokens now include a `token_type` claim (`"access"` or `"refresh"`). The auth middleware rejects refresh tokens used as access tokens. A `default_token_type()` function provides backward compatibility for pre-existing tokens during upgrade.
- **Login Response**: Now includes `expires_in` (seconds) alongside the access token, enabling the frontend to track token expiry locally.
- **Logout Flow**: Logout now revokes both the access token and the refresh cookie, and clears the `Set-Cookie` header for the refresh token.
- **SSO Callback**: Updated to issue both access and refresh tokens, setting the refresh cookie on the redirect response.

### Security
- **CSP Hardened**: Removed `'unsafe-inline'` from `script-src` in the Nginx Content-Security-Policy header. `style-src` retains `'unsafe-inline'` (acceptable risk for Tailwind CSS runtime styles).
- **Refresh Token Isolation**: Refresh tokens are only accepted by the `/api/auth/refresh` endpoint (scoped via `Path=/api/auth/refresh` on the cookie). They cannot be used as bearer tokens for API requests.

## [0.11.2] — 2026-04-14

### Changed
- **Role Dropdown Modernised**: The user-role dropdown in the Admin Users table now uses the unified custom `Select` component (with portal rendering and animations) instead of a native `<select>`, matching the style of all other dropdowns in the application.
- **Dependency Upgrade — rand 0.9**: Bumped the `rand` crate from 0.8 to 0.9, migrating all call-sites to the new API (`distr`, `rng()`, `random()`).

### Fixed
- **Migration Checksum Repair**: Deploying after the `.gitattributes` line-ending normalisation (CRLF → LF) caused the backend to crash-loop with _"migration N was previously applied but has been modified"_. The migrator now detects and auto-repairs stale SHA-384 checksums on startup, so existing environments upgrade seamlessly without manual intervention.

## [0.11.1] — 2026-04-14

### Added
- **User Role Management**: Admins can now change a user's role directly from the Users table via an inline dropdown, with audit logging of role changes.
- **Centralised Version File**: App version is now defined in a single root `VERSION` file. Both the Rust backend and Vite frontend read from it at build time, ensuring consistent versioning across services. The backend startup log and `/admin/health` endpoint now include the version, with a mismatch warning in the admin dashboard if frontend and backend versions diverge.

### Fixed
- **Case-Insensitive Email/Username Matching**: SSO login, local login, and user creation now use case-insensitive email and username matching. Previously, users created as `Charlotte.Smart2@capita.com` could not sign in if the OIDC provider returned `charlotte.smart2@capita.com`. Emails and usernames are normalised to lowercase on creation, and all lookups use `LOWER()`. Includes database migration to normalise existing data and replace the unique constraints with case-insensitive indexes.
- **Session Watermark Visibility**: The session watermark now renders with both a dark and light text pass, making it visible over both light and dark remote desktop backgrounds. Previously the white-only watermark was invisible over white application windows.
- **Session Watermark Z-Order**: Changed watermark from `position: absolute` to `position: fixed` with `z-index: 9999`, ensuring it always renders above the Guacamole display canvas rather than being painted underneath it.

## [0.11.0] — 2026-04-13

### Added
- **Windows Key Proxy (Right Ctrl)**: Browsers cannot capture the physical Windows key — the OS intercepts it before the browser sees it. Strata now remaps Right Ctrl as a Windows key proxy, following the VMware / VirtualBox "host key" convention:
  - **Hold Right Ctrl + key** → sends Win + key to the remote session (e.g., Right Ctrl + E → Win+E to open Explorer)
  - **Tap Right Ctrl alone** → sends a Win key tap (opens Start menu)
  - **Multi-key combos** work naturally (e.g., Right Ctrl + Shift + S → Win+Shift+S for screenshot)
  - Active across all session types: single session, tiled multi-session, pop-out windows, and shared viewer (control mode)
  - Protocol-aware: effective for RDP and VNC sessions; harmlessly ignored over SSH where the Super key has no meaning
- **Analytics Dashboard**: New analytics section on the Admin Dashboard with:
  - Daily usage trend chart (sessions per day + total hours overlay)
  - Average and median session duration cards
  - Total bandwidth card with human-readable formatting
  - Protocol distribution stacked bar chart
  - Peak hours 24-hour histogram
- **Session Bandwidth Tracking**: Per-session bandwidth (bytes from/to guacd) is now captured in the recordings table and displayed in the live sessions gauge
- **Dynamic Capacity Gauge**: The guacd capacity gauge now calculates `recommended_per_instance` dynamically based on host CPU cores and RAM (with 30% reserve), replacing the previous hardcoded value of 20

### Changed
- **Keyboard Input Architecture**: All four keyboard handler sites (SessionClient, TiledView, usePopOut, SharedViewer) now route through a shared `createWinKeyProxy()` utility, providing consistent key handling and a single point for future keyboard remapping features

## [0.10.6] — 2026-04-13

### Added
- **Folder View Auto-Select**: The dashboard now automatically enables folder view when connections belong to folders, giving users organised grouping out of the box.
- **Collapsed Folders by Default**: Folder groups start collapsed for a cleaner initial view. Users can expand individual folders on demand.
- **Persistent Folder Preferences**: The folder view toggle and per-folder expand/collapse states are persisted in `localStorage`, so the dashboard remembers your layout across sessions.

### Changed
- **VNC Recording Form Cleanup**: Removed system-managed recording fields (path, name, auto-create path) from the VNC connection edit form. Replaced with the user-configurable recording options (exclude graphical output, exclude mouse, exclude touch, include key events).
- **AD Sync Recording Defaults Cleanup**: Removed redundant recording-path, recording-name, and create-recording-path fields from AD Sync connection defaults since they are managed automatically by the system.

## [0.10.5] — 2026-04-13

### Added
- **Session Label Overlay**: Active session thumbnails now display the connection name and protocol as a sleek overlay at the bottom. This includes a dark gradient background and backdrop blur for maximum readability over varied remote desktop backgrounds.

### Fixed
- **Backend Test Coverage**: Implemented a comprehensive unit test suite for the `GuacamoleParser`, increasing backend coverage above the 20% threshold. Tests cover Unicode handling, partial data buffering, and malformed input recovery.
- **Rust Code Formatting**: Corrected `cargo fmt` violations in the recordings module to ensure consistent code style and CI compliance.

## [0.10.4] — 2026-04-12

### Fixed
- **Pop-Out Session Persistence**: Pop-out windows now survive navigation between the dashboard and session views. Previously, navigating away from the session page caused all pop-out windows to close because state was stored in local React refs that were destroyed on unmount. State is now stored on the session object in SessionManager, persisting across route changes.
- **Multi-Session Pop-Out Stability**: Disconnecting one popped-out session no longer causes other pop-out sessions to go black or become unresponsive. The auto-redirect logic now skips DOM reparenting for sessions that are displayed in their own pop-out window.

### Changed
- **Pop-Out Architecture**: Migrated popup window management from `usePopOut` local refs to `session._popout` on the `GuacSession` object. SessionManager now owns popup lifecycle via `cleanupPopout()`, ensuring proper teardown on session end regardless of component mount state.

## [0.10.3] — 2026-04-12

### Fixed
- **Auto-Redirect on Session End**: When a remote session ends (e.g., user signs out of Windows) and other sessions are still active, the client now automatically redirects to the next active session instead of freezing on a stale screen. The "Session Ended" overlay is only shown when the last session closes.

### Tests
- Added `SessionRedirect.test.tsx` regression tests covering tunnel-close redirect, last-session overlay, and false-positive guard during initial session creation.

## [0.10.2] — 2026-04-10

### Added
- **One-Off Vault Credentials**: Users can now select a saved vault credential profile directly from the connection credential prompt for a single session, without permanently mapping the profile to the connection. Available on both single-session and tiled multi-session connect flows.
- **NVR Playback Controls**: Session recordings now include a progress bar, speed selector (1×/2×/4×/8×), and server-paced replay with proper inter-frame timing.
- **Per-User Recent Connections**: Connection access history is now tracked per-user, so each user sees only their own recent connections on the dashboard. Added `user_connection_access` table (migration 026).

### Fixed
- **Server Logout Detection**: When a user logs out of the remote server (e.g., Windows Sign Out), the session now cleanly ends with a "Session Ended" overlay instead of endlessly reconnecting to a black screen.
- **Pop-Out Session Stability**: Connecting to a second server while one session is popped out no longer tears down the popup window. Pop-out sessions persist independently until explicitly returned or the page is closed.
- **Credential Mapping Permissions**: Fixed permission check for `set_credential_mapping` to include folder-based role assignments (`role_folders`), not just direct connection assignments.
- **NVR Black Screen**: Fixed `tunnel.oninstruction = null` bug where replay detection overwrote the Client's instruction handler. Added `display.onresize` callback for proper scaling.
- **NVR WebSocket URL**: Fixed `Guacamole.WebSocketTunnel.connect(data)` double query-string issue that caused tunnel errors during live observation.

### Security
- **Vault One-Off Access Control**: The one-off credential profile endpoint validates that the profile belongs to the requesting user and has not expired before decrypting, preventing unauthorized cross-user credential access.

## [0.10.1] — 2026-04-10

### Fixed
- **Build Stabilization**: Resolved critical build-time regressions in both the Rust backend and TypeScript frontend.
- **Frontend CSS Syntax**: Corrected malformed Tailwind v4 `@layer` nesting and missing selectors in `index.css`.
- **Azure Recording Streaming**: Implemented a memory-efficient custom streaming download service for Azure Blob recordings, bypassing official SDK limitations.
- **Sidebar Highlighting**: Fixed logic issue where "Admin" and "Live Sessions" links were both highlighted simultaneously.
- **Observe Session Route**: Restored missing route registration for administrative session observation.
- **Admin Tab Visibility**: Corrected visibility filter for the Admin dashboard tab to ensure users restricted to "Sharing" roles do not gain administrative access.
- **Folder Permission Tunnel Access**: Resolved an issue where users granted connection access via folder-level assignments were blocked from establishing WebSocket tunnels.
- **TypeScript Type Safety**: Removed unused state variables in several components to satisfy strict production build linting.

### Security
- **Hardened Tunnel Ticket Creation**: Implemented comprehensive permission validation (including direct and folder-based assignments) at the ticket-issuance layer to prevent unauthorized users from obtaining valid tunnel tickets.

### Changed
- **Isolated Connection History**: Refined the internal connection access queries to ensure strictly per-user tracking of recent connections, eliminating initial history overlap from legacy global data.
19: ## [0.10.0] — 2026-04-10

### Added
- **AD Sync Connection Defaults**: AD sync sources can now specify default Guacamole parameters (RDP performance flags, session recording settings) that are applied to all synced connections. Configurable via the new "Connection Defaults" section in the AD Sync edit form.
- **Connection Parameter Tooltips**: All connection settings (Performance, Screen Recording, Authentication) now display descriptive hover tooltips sourced from the official Apache Guacamole documentation.
- **Unified Session Bar**: Consolidated all session-specific controls (Sharing, File Browser, Fullscreen, Pop-out, On-Screen Keyboard) into a single, sleek, collapsible right-side dock.
- **Integrated Touch/OSK Toolbar**: On-screen keyboard shortcuts are now accessible directly within the Session Bar "Quick Tools" section, removing the floating keyboard button from the center of the screen.

### Changed
- **Zero-Footprint Layout**: The Session Bar overlay is now completely transparent to remote screen resolution, allowing remote sessions to utilize the full display area.
- **Smooth Responsive Resizing**: Implemented `ResizeObserver` in the session client to ensure remote sessions scale continuously and smoothly during sidebar/dock transitions, eliminating layout flashes.

### Fixed
- **Large Clipboard Support**: Implemented manual protocol-level text chunking (4096-char blocks) to support transferring massive clipboard content (10,000+ lines) without hitting Guacamole instruction size limits.
- **Backend Buffer Optimization**: Increased tunnel memory buffers to 16MB and explicitly tuned WebSocket message limits to 64MB for robust high-bandwidth data transfers.



### Added
- **Active Sessions Dashboard**: New real-time administrative dashboard for monitoring all active tunnel connections, including bandwidth tracking, duration, and remote host metadata.
- **Administrative Termination**: Administrators can now "kill" any active session directly from the Sessions dashboard, ensuring instant access revocation when needed.

### Changed
- **Reconnection Stability**: Overhauled the session client reconnection logic with 10-second stability thresholds and explicit retry counters to prevent infinite loops on permanent connection failures (e.g., certificate mismatches).
- **Version Synchronization**: Unified backend and frontend versioning to 0.9.0 for improved architectural consistency.

### Fixed
- **Tunnel Proxy Stability**: Resolved Rust borrow checker issues in the tunnel proxy (related to `kill_rx` ownership) and fixed WebSocket ↔ TCP handshake signal handling.
- **TypeScript Type Safety**: Fixed build regressions in the frontend test suite by ensuring all mock session objects include mandatory `remote_host` metadata.

## [0.8.0] — 2026-04-09

### Added
- **User Restoration**: Administrators can now restore soft-deleted user accounts from the Admin Settings dashboard within the 7-day retention window.
- **Manual SSL Support**: The Nginx gateway now supports user-provided SSL certificates via volume mount (`cert.pem`, `key.pem`).

### Changed
- **Infrastructure Consolidation**: Removed Caddy reverse proxy. Nginx (Frontend) now acts as the primary gateway, handling SSL termination, API/WebSocket proxying, security headers, and automatic HTTP-to-HTTPS redirection.
- **Optional Local Database**: The `postgres-local` service is now moved to a Docker Compose profile (`local-db`), allowing it to be bypassed when using an external database provided in the `.env` file.
- **Environment Overrides**: `DATABASE_URL` in the `.env` file now correctly takes precedence over the default bundled configuration.

### Fixed
- **Resource Cleanup**: Removed redundant Caddy configurations and volumes.
- **Documentation**: Updated all deployment guides and manual setup instructions to reflect the new Nginx architecture and Docker Compose profiles.

## [0.7.0] — 2026-04-09

### Added

#### Granular RBAC Permissions
- **9 role-based permissions**: `can_manage_system`, `can_manage_users`, `can_manage_connections`, `can_view_audit_logs`, `can_create_users`, `can_create_user_groups`, `can_create_connections`, `can_create_connection_folders`, `can_create_sharing_profiles`.
- **Role-folder assignments**: New `role_folders` table for many-to-many role-to-folder mapping with dedicated list/update endpoints.
- Permissions are extracted from the database at authentication time and exposed on the `/api/auth/me` response.

#### Connection Folders
- **Renamed `connection_groups` to `connection_folders`** across the full stack (database, API, frontend) for clarity.
- CRUD endpoints for connection folders with proper authorization checks.
- Frontend folder view with collapsible folder headers and per-folder connection counts.

#### Database Migrations
- **020**: `email`, `full_name`, `auth_type` columns on `users` table for strict SSO matching.
- **021**: Soft-delete (`deleted_at`) on users; granular `can_manage_*` / `can_view_*` permission columns on roles.
- **022**: Extended creation permissions (`can_create_users`, `can_create_user_groups`, `can_create_connections`, `can_create_connection_groups`, `can_create_sharing_profiles`).
- **023**: Rename `connection_groups` → `connection_folders` and `can_create_connection_groups` → `can_create_connection_folders` across all tables, indexes, and foreign keys.
- **024**: `role_folders` table for role-based folder access control.

#### Backend — Extracted Pure Functions & Input Validation
- **`redact_settings()`** — redacts sensitive config values (`sso_client_secret`, `vault_token`, `vault_unseal_key`, `ad_bind_password`, `azure_storage_access_key`) from API responses.
- **`validate_no_restricted_keys()`** — prevents updates to security-critical keys (`jwt_secret`, `sso_issuer_url`, `kerberos_realm`, `local_auth_enabled`) through the generic settings endpoint.
- **`is_safe_recording_filename()`** — prevents path traversal in recording download filenames (rejects `..`, `/`, `\`, empty strings).
- **`is_safe_hostname()`** — validates Kerberos hostnames to prevent `krb5.conf` injection.
- Unit tests for all extracted functions (14 new backend tests).

#### Docker Security Hardening
- **Backend**: Runs as non-root `strata:strata` user; pre-creates Guacamole recording and drive directories with correct ownership; `entrypoint.sh` fixes volume permissions before dropping privileges.
- **Frontend**: Runs nginx as non-root `nginx:nginx` user; pre-creates all cache/temp directories and PID file with correct ownership.

#### Documentation
- **`docs/security.md`**: Comprehensive security architecture covering OIDC authentication flow, local auth with Argon2id, authentication method enforcement, route protection matrix, envelope encryption with Vault Transit, and memory zeroization.

### Changed

#### Dependencies
- **sqlx** upgraded from 0.7.x to **0.8** with `runtime-tokio-rustls` feature set.
- **jsonwebtoken** upgraded from v9 to **v10** (`rust_crypto` feature).

#### Frontend Test Coverage
- **634 tests across 24 test files** (up from 605), all passing.
- Coverage thresholds enforced: statements 74%, branches 69%, functions 62%, lines 75%.
- New test suites: **Layout** (sidebar collapse, `useSidebarWidth`, nav highlighting), **AuditLogs** (pagination with Previous/Next), **Dashboard** (Previous page navigation).
- Expanded: **SessionMenu** (clipboard debounce send to remote after timer).

### Fixed
- **Settings redaction**: Sensitive settings are now automatically masked in all API responses.
- **Settings restriction**: Generic settings update endpoint no longer allows modification of security-critical keys.
- **Recording path traversal**: Filename validation prevents directory traversal attacks on recording downloads.
- **Kerberos hostname injection**: Hostname validation prevents shell injection in `krb5.conf` generation.

## [0.6.2] — 2026-04-09

### Changed

#### Frontend Test Coverage Expansion
- **Branch coverage raised from ~55% to 70%** across 605 tests (up from ~366), significantly improving regression safety.
- **Coverage thresholds enforced** in `vitest.config.ts`: statements 74%, branches 69%, functions 62%, lines 75% (previously 25/25/15/25).
- Expanded test suites for **AdminSettings** (133→145 tests), **Credentials** (28→42), **SessionMenu** (14→20), **FileBrowser** (13→20), **NvrPlayer** (17→23), **SharedViewer** (16→26), **SessionClient** (26→28), **SessionToolbar** (25→27), **SessionBar** (9→13), **SessionManager** (32→35), **TiledView** (16→22), **SessionWatermark** (4→7), **usePopOut** (15→20).
- Added new test files for **Layout** and **Login** components.

#### Backend Security & Reliability Hardening
- **Guacamole protocol parsing**: Improved Unicode character length handling to prevent connection failures with UTF-8 hostnames/credentials.
- **NVR instruction filtering**: Protocol-level opcode matching prevents false positives while blocking credentials in recordings.
- **Kerberos authentication**: Secure unique temporary files via `tempfile` for credential cache and CA certificate handling.
- **Tunnel soft-delete bypass**: Added `soft_deleted_at IS NULL` guard to WebSocket tunnel endpoint.
- **OIDC issuer validation**: Discovery endpoint now verifies returned issuer matches configured provider.
- **Content-Disposition header injection**: Recording download filename properly escaped.
- **Shared tunnel pool bypass**: Shared tunnel endpoint now uses `GuacdPool` for round-robin load distribution.
- **AD sync transaction safety**: Sync operations wrapped in database transactions.
- **`per_page` unbounded**: Pagination parameter now clamped to prevent arbitrarily large result sets.
- **Soft-delete leak fixes**: `connection_info`, `update_connection`, share list, and `revoke_share` endpoints now properly handle soft-deleted connections.
- **AD sync bulk operations**: High-performance bulk upsert/soft-delete query pattern replaces individual updates.
- **Database schema**: Added unique index on `connections(ad_source_id, ad_dn)` for sync integrity.

### Fixed
- Fixed `SessionManager.test.tsx` unused `afterEach` import (should have been `beforeEach`).
- Fixed portal duplicate text rendering in `Credentials` tests by using `aria-selected` attribute matching.
- Fixed canvas painting tests in `SessionWatermark` by mocking `HTMLCanvasElement` `clientWidth`/`clientHeight`.

## [0.6.1] — 2026-04-08

### Fixed

#### Security Hardening
- **Guacamole Protocol Parsing**: Improved parser to handle Unicode character lengths correctly, preventing connection failures or data corruption when using UTF-8 characters in hostnames or credentials.
- **NVR Instruction Filtering**: Refined sensitive instruction detection to use protocol-level opcode matching, preventing false positives while strictly blocking credentials in recordings.
- **Kerberos Authentication**: Hardened credential cache and CA certificate handling by using secure, unique temporary files via the `tempfile` library.
- **Tunnel soft-delete bypass**: WebSocket tunnel endpoint could connect users to soft-deleted connections — added `soft_deleted_at IS NULL` guard
- **OIDC issuer validation**: OIDC discovery endpoint did not verify that the returned issuer matched the configured provider, allowing potential token substitution
- **Content-Disposition header injection**: Recording download filename was not escaped, allowing header injection via crafted connection names
- **Shared tunnel pool bypass**: Shared tunnel endpoint created a direct guacd connection instead of using the `GuacdPool`, bypassing round-robin load distribution

#### Performance & Reliability
- **AD Sync Bulk Operations**: Replaced individual LDAP-to-DB updates with a high-performance **Bulk Upsert** (ON CONFLICT) and **Bulk Soft-Delete** query pattern.
- **Database Schema**: Added unique index on `connections(ad_source_id, ad_dn)` to ensure sync integrity and enable atomic upsert logic.
- **`connection_info` soft-delete leak**: `/api/user/connections/:id/info` returned protocol info for soft-deleted connections
- **`update_connection` soft-delete gap**: Update endpoint did not include a soft-delete filter, allowing edits to deleted connections
- **`update_connection` missing `updated_at`**: Updating a connection did not set `updated_at = now()`, leaving the timestamp stale
- **Share list stale data**: Share list query did not filter out soft-deleted connections
- **`revoke_share` silent no-op**: Revoking a non-existent or already-revoked share returned 200 OK — now returns 404 and checks `NOT revoked`
- **AD sync transaction safety**: AD sync update operations were not wrapped in a database transaction, risking partial updates on failure
- **`per_page` unbounded**: Pagination `per_page` parameter was not clamped, allowing arbitrarily large result sets

### Build
- Fixed unused `afterEach` import in `SessionManager.test.tsx` (should have been `beforeEach`)

## [0.6.0] — 2026-04-08

### Added
- **SSO / OIDC (Keycloak) Support**: Integrated OpenID Connect authentication.
  - New endpoints: `GET /api/auth/sso/login` (redirect) and `GET /api/auth/sso/callback` (handler).
  - Secure storage of OIDC client secrets using HashiCorp Vault.
  - Automatic OIDC discovery via `/.well-known/openid-configuration`.
- **Configurable Authentication Methods**: Admin can now toggle between Local Authentication and SSO/OIDC in the Security settings.
- **Improved Security Enforcement**: Backend system now strictly enforces the `local_auth_enabled` policy, rejecting local logins when disabled.

### Fixed
- **Security Loophole**: Fixed a flaw where local authentication remained functional even when disabled in the dashboard.
- **UI Consistency**: Resolved an issue where the Security tab checkboxes could appear disabled by default when unconfigured.
- **Build Regressions**: 
  - Fixed TypeScript compilation errors in frontend tests related to unused imports and variables.
  - Resolved `Cannot find name 'vi'` build error in test setup by importing the Vitest utility.
  - Suppressed Rust compiler warnings (`dead_code`, `unreachable_patterns`) in the backend authentication service.

## [0.5.0] — 2026-04-07

### Added

#### Active Directory LDAP Sync
- Automatic computer account import from Active Directory via LDAP/LDAPS
- AD sync config CRUD API: `GET/POST/PUT/DELETE /api/admin/ad-sync-configs`
- `POST /api/admin/ad-sync-configs/test` — test connection endpoint that validates connectivity and returns a preview of first 10 discovered objects with DNS hostnames
- Manual sync trigger: `POST /api/admin/ad-sync-configs/:id/sync`
- Sync run history: `GET /api/admin/ad-sync-configs/:id/runs` with per-run stats (created, updated, soft-deleted, hard-deleted)
- Background scheduled sync — configurable interval per source (default: 60 minutes)
- Soft-delete lifecycle — objects that disappear from AD are soft-deleted for 7 days before permanent hard-deletion
- Multiple search bases per config — query multiple OU scopes in a single source, results deduplicated by DN (`015_multi_search_base.sql` migration)
- Search filter presets dropdown: All Computers, Servers Only, Enabled Computers Only, Enabled Servers Only, Custom Filter
- Automatic exclusion of gMSA (`msDS-GroupManagedServiceAccount`) and MSA (`msDS-ManagedServiceAccount`) accounts from all preset filters
- Connection group assignment — imported connections can be placed into a specific connection group
- Domain override — optional domain suffix forced onto all imported connections
- Full admin UI in the "AD Sync" tab: source cards with label, URL, auth method, bases, filter, protocol, interval; inline edit form; sync history table

#### AD Sync Authentication Methods
- **Simple Bind** — bind DN + password with LDAP/LDAPS
- **Kerberos Keytab** — `kinit` + `ldapsearch` with GSSAPI via keytab file and configurable principal
- Per-config credential cache (`KRB5CCNAME`) to avoid races between concurrent syncs

#### CA Certificate Upload for LDAPS
- Upload internal CA certificates (PEM/CRT/CER) for LDAPS connections with self-signed or internal CAs
- Custom `rustls` `ClientConfig` built at query time with system roots + uploaded CA (bypasses ldap3's static `CACERTS`)
- Kerberos path writes PEM to temp file and sets `LDAPTLS_CACERT` env var for `ldapsearch`
- UI: file upload button hidden when "Skip TLS verification" is checked; shows "✓ Certificate loaded" with replace/remove actions
- `ca_cert_pem` TEXT column added to `ad_sync_configs` (`014_ca_cert.sql` migration)

#### Multi-Realm Kerberos
- Support for multiple Kerberos realms, each with its own KDCs, admin server, ticket/renew lifetimes, and default flag
- Full CRUD API for Kerberos realms: `GET/POST/PUT/DELETE /api/admin/kerberos-realms`
- Dynamic `krb5.conf` generation aggregating all realms with correct `[realms]` and `[domain_realm]` sections
- Realm management UI with inline edit form in the Kerberos admin tab
- `011_multi_kerberos.sql` migration: `kerberos_realms` table with `id`, `realm`, `kdcs`, `admin_server`, `ticket_lifetime`, `renew_lifetime`, `is_default`

#### Credential Profiles
- Saved credential profiles with optional TTL expiry (`credential_profiles` table)
- Profile selector dropdown on the Dashboard connection card — pick a saved profile or enter credentials inline
- `008_credential_profiles.sql`, `009_credential_expiry.sql`, `010_profile_ttl.sql` migrations

#### Kerberos Keytab Auth for AD Sync
- `auth_method` column on `ad_sync_configs`: `simple` or `kerberos` (`013_keytab_auth.sql` migration)
- `keytab_path` and `krb5_principal` fields for keytab-based authentication
- Auth method selector in the AD sync edit form toggles between Simple Bind and Kerberos Keytab fields

### Changed
- `AdSyncConfig` struct: `search_base: String` replaced with `search_bases: Vec<String>` (Postgres `TEXT[]`)
- LDAP query functions accept individual search base parameter; `ldap_query()` iterates over all bases and deduplicates by DN
- All LDAP filter defaults and presets now include `(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount))` to exclude service accounts
- Backend dependencies: added `rustls 0.21`, `rustls-pemfile 1`, `rustls-native-certs 0.6` for custom TLS config
- Architecture docs updated with AD sync, multi-realm Kerberos, credential profiles, and CA cert sections
- Database schema docs updated through migration 015

### Fixed
- Empty `search_filter` in DB caused ldap3 filter parse error — now falls back to the default exclusion filter
- ldap3 `UnknownIssuer` TLS error with internal CAs — bypassed static `CACERTS` with per-query custom `ClientConfig`

### Security
- CA certificates stored in database (not filesystem) and loaded per-query — no global mutable state
- Keytab-based authentication uses per-config `KRB5CCNAME` credential cache to prevent cross-config credential leakage
- Bind passwords stored as-is in `ad_sync_configs` (same trust boundary as the admin API) — future: Vault envelope encryption

## [0.4.0] — 2026-04-07

### Added

#### Azure Blob Storage for Session Recordings
- Session recordings can now be synced to **Azure Blob Storage** as an external storage backend
- New Admin UI controls in the Recordings tab: storage backend selector (Local / Azure Blob), account name, container name, and access key fields
- Background sync task uploads completed recordings from the local volume to Azure Blob every 60 seconds
- Recording download endpoint falls back to Azure Blob when a file is not found locally
- Azure Blob REST API integration uses SharedKey authentication with HMAC-SHA256 (no extra SDK dependencies)
- New DB settings: `recordings_storage_type`, `recordings_azure_account_name`, `recordings_azure_container_name`, `recordings_azure_access_key`

#### Collaborative Control Mode Shares
- Share links now support two modes: **View** (read-only, default) and **Control** (full keyboard and mouse input forwarding)
- Share popover in the session toolbar presents two buttons — "View Only" and "Control" — with distinct icons and colour badges
- `POST /api/user/connections/:id/share` accepts a `{ "mode": "view" | "control" }` request body
- `mode` column added to `connection_shares` table (`007_share_mode.sql` migration)
- Shared viewer detects mode from URL query parameter (`?mode=control`) and conditionally attaches keyboard input
- Banner in shared viewer displays "Control mode" or "Read-only view" accordingly
- "Generate new link" button in share popover to create a fresh link without closing the popover
- Audit log captures share mode alongside token and connection ID

#### Auto-HTTPS with Caddy
- `Caddyfile` reverse proxy configuration — routes `/api/*` to the Rust backend and everything else to the frontend nginx container
- Caddy service in `docker-compose.yml` under the `https` profile — activate with `docker compose --profile https up`
- Automatic Let's Encrypt TLS certificates when `STRATA_DOMAIN` environment variable is set
- HTTP/3 (QUIC) support via UDP port 443 binding
- Built-in gzip/zstd compression and security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- `caddy-data` and `caddy-config` Docker volumes for certificate and configuration persistence

#### Health & Load Metrics
- Per-session bandwidth tracking via atomic counters — bytes received from guacd and bytes sent to guacd
- `protocol` field added to active session records for per-protocol metrics breakdown
- `GET /api/admin/metrics` — admin endpoint returning aggregate metrics:
  - `active_sessions` — total number of active tunnel sessions
  - `total_bytes_from_guacd` / `total_bytes_to_guacd` — cumulative bandwidth
  - `sessions_by_protocol` — session count grouped by protocol (RDP, SSH, VNC)
- `MetricsSummary` type and `getMetrics()` function added to the frontend API client
- Active session list now includes `protocol`, `bytes_from_guacd`, and `bytes_to_guacd` fields

#### PWA & Tablet Gesture Support
- `manifest.json` — Progressive Web App manifest with standalone display mode, dark theme colour, and app icons
- `sw.js` — Service worker with shell caching (network-first for navigation, cache-first for static assets; API requests are never cached)
- `index.html` updated with `<link rel="manifest">`, `theme-color` meta tag, and Apple mobile web app meta tags
- `viewport-fit=cover` for edge-to-edge rendering on notched devices
- Service worker registration on page load
- **Touch Toolbar** — floating `⌨` button that expands into a horizontal strip of special key combos:
  - Ctrl+Alt+Delete, Windows key, Alt+Tab, Escape, F11, Ctrl+Alt+T (terminal)
  - Renders at bottom-centre of the session view; automatically integrated into SessionClient

#### Sidecar guacd Scaling
- `GuacdPool` service — round-robin connection pool distributing tunnel connections across multiple guacd instances
- `guacd_instances` configuration field (`config.toml`) and `GUACD_INSTANCES` environment variable (comma-separated `host:port` entries)
- Backend automatically builds a pool from the primary guacd instance plus any additional instances
- Tunnel handler picks the next guacd from the pool for each new connection
- `guacd-2` service template in `docker-compose.yml` under the `scale` profile — activate with `docker compose --profile scale up`
- Startup log message reports pool size when more than one instance is configured

#### H.264 GFX Encoding
- RDP connections now default to FreeRDP 3 GFX pipeline with H.264 encoding (`enable-gfx=true`, `enable-gfx-h264=true`) for significantly lower bandwidth usage
- These parameters are set as defaults in the handshake and can be overridden per-connection via the `extra` JSONB field
- `ffmpeg-dev` added to guacd builder stage and `ffmpeg-libs` added to runtime stage for H.264 codec support

### Changed
- `AppError` enum gains a `Validation` variant — returns HTTP 400 for invalid request data (e.g. bad share mode)
- `ActiveSession` struct now includes `protocol` and bandwidth counters
- `SessionInfo` serialisation includes `protocol`, `bytes_from_guacd`, and `bytes_to_guacd`
- `ShareLinkResponse` includes `mode` field in the JSON response
- Share URL for control mode includes `?mode=control` query parameter
- `NvrContext` now carries `protocol` for session registration
- `AppState` includes `guacd_pool` for multi-instance support
- Frontend `ActiveSession` TypeScript type updated with `protocol`, `bytes_from_guacd`, `bytes_to_guacd`
- Docker Compose volumes section expanded with `caddy-data` and `caddy-config`

### Security
- Control mode shares forward keyboard and mouse input to the remote session via the share token — treat control share links with the same sensitivity as credentials
- Caddy security headers added: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
- Service worker explicitly excludes `/api` requests from caching — authentication tokens are never cached

## [0.3.0] — 2026-04-06

### Added

#### Live Session NVR Mode
- In-memory per-session ring buffer capturing up to 5 minutes (50 MB cap) of Guacamole protocol frames
- `SessionRegistry` service tracking all active tunnel sessions with connection metadata and buffer depth
- Admin “Sessions” tab in Admin Settings showing live sessions with user, connection, duration, and buffer depth
- `GET /api/admin/sessions` — list all active tunnel sessions
- `GET /api/admin/sessions/:id/observe` — WebSocket endpoint that replays buffered frames then switches to live broadcast
- **Observe Live** — admin can watch a user’s session in real-time (read-only)
- **Rewind** — admin can rewind up to 5 minutes to see what the user did before they called for help
- NVR Player page (`/observe/:sessionId`) with Guacamole client, status badge (Replaying / LIVE / Ended), elapsed timer, and rewind buttons (30s, 1m, 3m, 5m)
- Automatic replay→live transition detection based on instruction timing
- Last known `size` instruction cached for display dimension injection on replay

#### Connection Groups & Organisation
- Connection groups / folders with nested hierarchy (`connection_groups` table with `parent_id` self-reference)
- Description field on connections for notes and documentation
- Collapsible group headers on the Dashboard with an "Ungrouped" section for unassigned connections
- Group view toggle on the Dashboard (flat list vs. grouped view)
- Full CRUD API for connection groups (`GET/POST/PUT/DELETE /api/admin/connection-groups`)
- Group selector dropdown in the Admin connection editor
- Default keyboard layout set to UK English (Qwerty) and timezone to Europe/London for new connections

#### Favorites
- Star/unstar connections for quick access (`user_favorites` table, `005_favorites.sql` migration)
- Favorites filter button on the Dashboard
- `GET /api/user/favorites` — list favorited connection IDs
- `POST /api/user/favorites` — toggle favorite on/off

#### Theme & UI
- Light/dark/system theme toggle button in the sidebar (moon/sun icon, cycles System → Light → Dark)
- Refined dark theme: surfaces lifted from near-black to layered charcoal (`#111114` base, `#1a1a1f` cards, `#222228` elevated)
- Cards receive an inset top-edge glass highlight for depth
- Table headers use surface-tertiary background
- Ambient gradients strengthened 50%
- Input fields recessed darker than cards for inset relief

### Changed
- Admin users now see **all** connections on the Dashboard regardless of role assignment (bypasses `role_connections` filter)
- Non-admin users continue to see only connections mapped to their role
- `GET /api/user/connections` response now includes `description`, `group_id`, and `group_name` fields
- `GET /api/admin/connections` response now includes `description` and `group_id` fields
- `POST /api/admin/connections` and `PUT /api/admin/connections/:id` accept `description` (string) and `group_id` (UUID, optional)
- Dashboard `ConnectionRow` displays description below connection name
- Database schema: `006_groups_and_description.sql` migration adds `connection_groups` table and `description`/`group_id` columns to `connections`

### Fixed
- Admin users could not see connections that were not assigned to any group or role on the Dashboard

## [0.2.0] — 2026-04-06

### Added

#### Multi-Session & Tiled View
- Tiled multi-session layout with responsive grid, per-tile focus, and `Ctrl`/`Cmd`+click multi-focus
- Keyboard broadcast to all focused tiles simultaneously
- Inline credential prompts for RDP connections in tiled view (per-tile prompt flow)
- Session bar with live thumbnails and tiled mode indicator

#### Clipboard & File Transfer
- Automatic bidirectional clipboard synchronisation between local and remote sessions
- Drag-and-drop file upload onto the session canvas
- In-browser file browser panel with directory navigation, upload progress, and file download
- RDP virtual drive mounting (`enable-drive` enabled by default for all RDP connections)

#### Connection Sharing
- Generate temporary read-only share links for live sessions (`POST /api/user/connections/:id/share`)
- Public shared tunnel endpoint (`GET /api/shared/tunnel/:share_token`) — no auth required
- Share URLs use full origin prefix for portability
- Session toolbar with share link generation and copy-to-clipboard

#### Bundled HashiCorp Vault
- HashiCorp Vault 1.19 container added to Docker Compose with file storage backend and persistent volume
- Automatic Vault initialization (single unseal key, single key share) on first boot
- Automatic unseal and Transit engine provisioning (enable engine + create encryption key)
- `vault_provisioning` backend service handling full Vault lifecycle (health, init, unseal, enable_transit, create_transit_key)
- Setup wizard vault mode selector: **Bundled** (auto-configured), **External** (user-provided), or **Skip**
- Admin Settings vault tab with mode switching between Bundled and External
- Auto-unseal of bundled Vault on backend startup using stored unseal key
- `vault_configured` field on `/api/status` endpoint; conditional "Update" button on Dashboard
- Health endpoint reports vault mode (local/external) alongside status

#### UI Polish
- Premium animated checkboxes with custom CSS (checkPop keyframe, indeterminate state, hover glow, press-down scale)
- Last Accessed column on Dashboard with live tracking (`004_last_accessed.sql` migration)
- Collapsible sidebar navigation
- Tailwind CSS v4 migration (CSS-first `@theme` configuration, warm zinc palette)

#### Local Authentication
- Username/password authentication for environments without an OIDC provider (`002_local_auth.sql` migration)

### Changed
- Vault Docker image upgraded from `1.17` to `1.19` (latest stable community release)
- `VaultHealth` API response now includes `mode` field (`local` | `external`)
- `InitRequest` API accepts `vault_mode` field (`local` | `external`)
- `updateVault` admin API accepts `mode` field for switching between bundled and external Vault
- Architecture diagram updated to show Vault as a bundled container (previously external-only)
- Setup wizard redesigned with radio-card vault mode selector replacing plain text fields
- Admin Settings vault tab redesigned with mode toggle and context-aware field display
- Health tab vault card shows mode badge (Bundled/External) and links to Vault configuration tab

### Security
- Vault unseal key and root token stored in `config.toml` (backend-config volume) — not logged or exposed via API
- Bundled Vault runs with `IPC_LOCK` capability and `disable_mlock = true` for container compatibility
- Vault container on internal network only — not exposed to host

## [0.1.0] — 2026-03-15

### Added

#### Infrastructure (Phase 1)
- Docker Compose orchestration for all services (guacd, backend, frontend, PostgreSQL)
- Custom `guacd` Dockerfile with FreeRDP 3 (`ARG FREERDP_VERSION=3`) and Kerberos (`krb5-dev`, `krb5-libs`) support
- Bundled PostgreSQL 16 Alpine container with persistent volume and health checks
- Shared Docker volumes for session recordings (`guac-recordings`) and Kerberos config (`krb5-config`)
- `.env.example` with configurable ports and log levels
- `.gitignore` for build artifacts, IDE files, and secrets

#### Rust Backend (Phase 2)
- Axum + Tokio web server with graceful startup (setup vs. running mode)
- `config.toml`-based persistence with auto-detection on boot
- First-boot setup endpoint (`POST /api/setup/initialize`) supporting local and external database selection
- PostgreSQL advisory-lock-protected SQL migrations (`sqlx::migrate!`) for HA-safe schema upgrades
- Full normalized database schema: `system_settings`, `users`, `roles`, `connections`, `role_connections`, `user_credentials`, `audit_logs`
- HashiCorp Vault Transit envelope encryption (`seal` / `unseal`) with AES-256-GCM and `zeroize` memory cleanup
- OIDC token validation via dynamic JWKS discovery (supports Keycloak, Entra ID, any compliant provider)
- JWT authentication middleware (`require_auth`) extracting user identity from Bearer tokens
- Role-based authorization middleware (`require_admin`) for admin-only endpoints
- Dynamic Kerberos `krb5.conf` generation written to shared volume
- Session recording configuration from database settings
- SHA-256 hash-chained immutable audit logging
- Bidirectional WebSocket ↔ TCP proxy tunnel to `guacd` with Guacamole protocol handshake injection
- Role-based connection access control on tunnel establishment
- Admin CRUD API: settings, SSO, Kerberos, recordings, roles, connections, users, audit logs
- User API: profile, role-scoped connections, credential vault, recording file download
- Health check and system status endpoints
- CORS and request tracing middleware
- Structured JSON logging via `tracing`

#### Frontend SPA (Phase 3)
- React 18 + TypeScript + Vite project scaffold
- Typed API client (`api.ts`) covering all backend endpoints
- Setup Wizard with database mode selection and optional Vault configuration
- Admin Settings Dashboard with five tabs: Database migration, SSO/OIDC, Kerberos, Recordings, Access Control
- Role and connection management UI (create, list, map roles to connections)
- User list viewer
- Connection dashboard with credential vault (Vault-encrypted password save)
- Session client mounting `guacamole-common-js` to HTML5 Canvas with dynamic resolution scaling
- Paginated, hash-verified audit log viewer
- Responsive navigation layout with active route highlighting
- nginx reverse proxy configuration for SPA fallback and API proxying
- Production Dockerfile (multi-stage Node build → nginx)
- Dark theme CSS design system

#### CI/CD (Phase 4)
- GitHub Actions workflow (`build-guacd.yml`) for automated weekly upstream guacd builds
- Automatic latest release tag detection from `apache/guacamole-server`
- Multi-platform Docker build with GHCR push and GitHub Actions cache
- Manual dispatch with version override input

### Security
- All user credentials encrypted at rest using envelope encryption (AES-256-GCM + Vault Transit KEK)
- Plaintext DEKs zeroized from memory immediately after use
- OIDC tokens validated against provider JWKS with audience and issuer checks
- Recording file endpoint sanitizes filenames to prevent path traversal
- Admin routes protected by role-based middleware
- Database credentials never logged; Vault tokens stored only in config
- Audit log chain integrity verifiable via SHA-256 hash links
