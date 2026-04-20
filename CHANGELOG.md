# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.19.4] — 2026-04-20

### Fixed
- **Expired Managed Credentials No Longer Bypass Renewal Prompt**: Connecting with an expired or checked-in managed credential profile previously dropped straight into "Authentication failure (invalid credentials?)" because the session view stayed in the loading phase and stale/empty credentials were still passed to the remote host. The session client now correctly enters the renewal prompt when the backend reports an `expired_profile`, and the tunnel backend refuses to proceed when the only available credential source is an expired managed profile — preventing repeated failed binds against AD (which could also contribute to account lockout).

### Added
- **Inline Checkout Request on Connect (Approval-Required Managed Accounts)**: When a connection is attempted with an expired/checked-in managed credential profile that requires administrator approval, users now see an inline checkout request form (justification + duration) directly in the session view. Submitting queues a pending approval and clearly informs the user that the connection is blocked until approved — no need to navigate away to the Credentials tab.
- **Unified Self-Approve & Approval-Required Flow**: Self-approving users get an identical form and, on submit, the checkout is immediately activated, linked to the existing profile, and the session proceeds to connect without additional clicks.

### Changed
- **Backend Tunnel Safety Check**: `tunnel.rs` now performs an explicit `credential_mappings`/`credential_profiles` check after credential resolution. If the only credential source for a connection is a managed profile that has expired (`expires_at <= now()`), the WebSocket tunnel returns a validation error instead of opening a session with missing credentials.
- **Session Renew Callback**: `handleRenewAndConnect` now includes `renewJustification` in its dependency array and routes all managed-account renewals (self-approve and approval-required) through a single request path, surfacing an explicit "pending administrator approval" message when the returned checkout status is not `Active`.

## [0.19.3] — 2026-04-20

### Added
- **Separate Search Base OUs for Password Management**: Introduced a dedicated `pm_search_bases` configuration field for Active Directory synchronization. This allows administrators to scope user discovery for password management to specific OUs, separate from the primary device-focused search bases. 
- **Optional Search Base Fallback**: The system now supports an optional fallback mechanism: if specific PM search bases are not configured, user discovery automatically falls back to the main device search bases, ensuring backward compatibility with existing configurations.
- **Interactive Search Base UI**: Updated the Admin Settings AD Sync configuration modal with an interactive, multi-entry input for PM Search Base OUs, matching the primary search base pattern.

### Technical Refinements
- **API Enhancements**: Updated `CreateAdSyncConfigRequest` and `UpdateAdSyncConfigRequest` DTOs to support optional PM search base persistence.
- **User Discovery Optimization**: Refined `list_unmapped_accounts` and account filter preview logic to prioritize PM-scoped discovery perimeters.

### Database
- **Migration 049**: Adds `pm_search_bases` (`TEXT[]`) column to the `ad_sync_configs` table.

## [0.19.2] — 2026-04-20

### Added
- **Connection Health Checks**: Background TCP probing of every connection's hostname:port every 2 minutes with a 5-second connect timeout. Results (online/offline/unknown) are persisted in the database and exposed via the connections API. Dashboard displays green/red/gray status dots next to each connection for at-a-glance operational visibility without requiring agents on target machines.
- **Checked-In Status for Password Checkouts**: Users can now voluntarily check-in (return) an active password checkout before its expiry. Adds `CheckedIn` to the `password_checkout_requests` status enum, triggering immediate password rotation on check-in.
- **Credential Profile ↔ Checkout Link**: Credential profiles can now reference a `checkout_id` linking them to the password checkout they were generated from. Enables automatic cleanup and traceability between vault profiles and PM checkouts.

### Fixed
- **Migration Resilience (048)**: Added idempotent repair migration `048_connection_health_repair.sql` to safely add `health_status` and `health_checked_at` columns on environments where migration 042 was recorded as applied but the DDL did not take effect. Uses `IF NOT EXISTS` for columns and `pg_constraint` checks for the CHECK constraint.

### Database
- **Migration 042**: Adds `health_status` (TEXT, NOT NULL, DEFAULT 'unknown', CHECK constraint) and `health_checked_at` (TIMESTAMPTZ) columns to `connections` table.
- **Migration 043**: Adds `checkout_id` FK column to `credential_profiles`; relaxes `encrypted_username` NOT NULL constraint for managed credential profiles.
- **Migration 044**: Extends `password_checkout_requests` status CHECK constraint to include `CheckedIn`.
- **Migration 048**: Idempotent repair — ensures health columns and constraint exist regardless of prior migration state.

## [0.19.1] — 2026-04-20

### Added
- **DNS Search Domains**: The Network tab now supports configurable DNS search domains alongside DNS servers. Search domains are written as a `search` directive in the generated `resolv.conf`, enabling short-name resolution for internal zones (e.g. `.local`, `.dmz.local`). This is equivalent to the `Domains=` directive in `systemd-resolved` on the host OS.
- **Docker DNS Fallback**: The generated `resolv.conf` now appends Docker's embedded DNS resolver (`127.0.0.11`) as a fallback nameserver. This ensures existing connections that resolve via public DNS or Docker service discovery continue working when custom DNS is enabled — no reconfiguration needed.
- **Migration 047 (Backfill)**: New migration `047_dns_search_domains.sql` backfills the `dns_search_domains` key into `system_settings` for instances that already ran migration 046 before search domains were added. Uses `ON CONFLICT DO NOTHING` for idempotent application.

### Changed
- **DNS Configuration (Network Tab)**: Updated to include a Search Domains input field with domain format validation (max 6 domains). The "How it works" explanation now describes the equivalence to `systemd-resolved` `Domains=` directive.
- **Backend DNS endpoint**: `PUT /api/admin/settings/dns` now accepts `dns_search_domains` (comma-separated domain list). Validated domain names are written as a `search` line in the generated `resolv.conf`. Audit log includes search domains in the event payload.
- **resolv.conf generation**: Now writes `search <domains>` line (when configured), followed by custom `nameserver` entries, followed by `nameserver 127.0.0.11` as Docker DNS fallback.

### Database
- **Migration 047**: Backfills `dns_search_domains` key into `system_settings` for existing installations.

## [0.19.0] — 2026-04-19

### Added
- **DNS Configuration (Network Tab)**: Administrators can now configure custom DNS servers and search domains for guacd containers directly from the Admin Settings UI via a new **Network** tab. DNS entries are validated (IPv4 format), search domains are validated (domain format, max 6), persisted in `system_settings`, and written to a shared Docker volume (`backend-config`) as `resolv.conf`. The guacd entrypoint copies this file on startup, enabling resolution of internal hostnames (e.g. `.local`, `.dmz.local` domains) without hardcoding DNS in `docker-compose.yml`. A restart-required banner reminds admins to run `docker compose restart guacd` after changes.
  - **Migration**: `046_dns_settings.sql` inserts `dns_enabled` (false), `dns_servers` (empty), and `dns_search_domains` (empty) into `system_settings`.
  - **Backend**: New `PUT /api/admin/settings/dns` endpoint with IPv4 validation, domain validation, DB persistence, `resolv.conf` file write (with Docker DNS fallback), and audit logging.
  - **Frontend**: `NetworkTab` component with DNS enable toggle, DNS servers input, search domains input, client-side validation, "How it works" explanation, and restart-required warning after save.
  - **guacd**: New `entrypoint.sh` wrapper that applies `/app/config/resolv.conf` before starting the daemon. Uses `su-exec` to drop privileges to the `guacd` user.
- **Dynamic Browser Tab Title**: The browser tab now displays the active session's server name while connected (e.g. "SERVER01 — Strata"), making it easy to identify which server you're on when the sidebar is collapsed or when switching between browser tabs. Reverts to "Strata Client" on disconnect.

### Changed
- **guacd Dockerfile**: Added `su-exec` to runtime packages, replaced direct `USER guacd` + `ENTRYPOINT` with a custom `entrypoint.sh` that applies DNS configuration before dropping privileges. Added `/app/config` directory for shared volume mount.
- **Docker Compose**: Removed hardcoded `dns:` directives from `guacd` and `guacd-2` services (DNS is now UI-managed). Added `backend-config:/app/config:ro` volume mount to both guacd services.

### Removed
- Removed test scripts (`test_me.sh`, `test_me2.sh`) containing debug/throwaway code.

### Database
- **Migration 046**: Inserts `dns_enabled`, `dns_servers`, and `dns_search_domains` keys into `system_settings` for UI-driven DNS configuration.

## [0.18.0] — 2026-04-18

### Added
- **Approval Role Account Scoping**: Approval roles now use direct account-to-role mapping (`approval_role_accounts` table) instead of LDAP target filter matching (`approval_group_mappings`). Each approval role is explicitly scoped to specific managed AD accounts via a searchable dropdown selector. This replaces the previous LDAP filter-based approach for precise, auditable control over which accounts each approver can approve checkouts for.
  - **Migration**: `045_approval_role_accounts.sql` creates the `approval_role_accounts` table with `(role_id, managed_ad_dn)` composite unique index and drops the legacy `approval_group_mappings` table.
  - **Admin UI**: Approval role configuration now shows a searchable dropdown populated from all PM-enabled AD sync sources, with selected accounts displayed as removable chip tags. Replaces the previous checkbox grid for improved scalability with large account sets.
  - **Backend**: New CRUD endpoints for `approval_role_accounts`. The `pending_approvals` query now scopes pending requests to only those accounts explicitly listed in the approver's role, rather than matching against LDAP filters.
- **Approver Navigation Visibility**: The "Pending Approvals" sidebar link is now conditionally visible only to users who are assigned to at least one approval role. The `is_approver` boolean is returned by both `/api/user/me` and `/api/auth/check` endpoints and derived from `SELECT EXISTS(SELECT 1 FROM approval_role_assignments WHERE user_id = $1)`.
- **Requester Username on Pending Approvals**: Checkout requests now include the `requester_username` field, populated via a `LEFT JOIN users` in the pending approvals query. The Approvals page displays the requester's username and avatar instead of a raw UUID.
- **Checkout Request "Decided By" Column**: The Checkout Requests table in Admin Settings now shows who approved or denied each request. Displays the approver's username, "Self Approved" when the approver is the same user as the requester, or "—" for undecided requests.

### Improved
- **Approvals Page Redesign**: Complete visual overhaul of the Pending Approvals page with a premium card-based layout. Each request card features an avatar circle with the requester's initial, labeled sections (ACCOUNT showing CN with full DN below, DURATION formatted as hours/minutes, JUSTIFICATION in an elevated surface box), and prominent approve/deny buttons with SVG icons and disabled state during decision processing.
- **CN Display Helper**: New `cnFromDn()` utility correctly extracts the Common Name from Distinguished Names, handling escaped commas (e.g., `CN=Smith\, John (Tier 1),OU=...` → `Smith, John (Tier 1)`).
- **Approval Role Delete Button Styling**: Changed from solid red `btn-danger` to `btn-secondary text-danger` to match the site-wide delete button pattern used in AD Sync configuration.
- **Unmapped Accounts Refresh**: The unmapped accounts list now auto-refreshes when the selected AD source changes, ensuring the dropdown always reflects the current state.

### Fixed
- **Managed Credential Override in Tunnel**: Fixed an issue where the tunnel handshake would use ticket-supplied credentials even when a managed checkout password was active for the connection's managed AD account. The managed credential path now takes priority when the connection has a `managed_ad_dn` and an active checkout exists.
- **Checkout Expiry `expires_at` Calculation**: Fixed a bug where `expires_at` was computed from the original request time instead of the approval time, causing checkouts to expire earlier than the requested duration.
- **Pending Approvals Scope**: Approvers now only see checkout requests for accounts explicitly assigned to their approval role, preventing visibility of requests outside their scope.

### Database
- **Migration 045**: Creates `approval_role_accounts` table (role_id + managed_ad_dn with cascade delete and composite unique index). Drops legacy `approval_group_mappings` table.

## [0.17.0] — 2026-04-18

### Added
- **Password Management (Account Password Blade)**: Full privileged account password checkout, rotation, and approval workflow for AD-managed accounts.
  - **Backend**: New `checkouts.rs` service with password generation (configurable policy), LDAP `unicodePwd` reset, Vault-sealed credential storage, checkout lifecycle (request → approve → activate → expire), and two background workers (60s expiration sweep, daily auto-rotation).
  - **Migration**: `041_password_management.sql` adds PM columns to `ad_sync_configs`, creates `approval_roles`, `approval_role_assignments`, `approval_group_mappings`, `user_account_mappings`, and `password_checkout_requests` tables.
  - **Admin Endpoints**: CRUD for approval roles, role assignments, AD target filter mappings, user-to-account mappings, unmapped account discovery, test rotation, and checkout request listing.
  - **User Endpoints**: Request checkout (`POST /user/checkouts`), list own checkouts, list pending approvals, approve/deny decisions, and password reveal for active checkouts.
  - **Admin UI**: New "Password Mgmt" tab in Admin Settings with three sub-tabs: Approval Roles (create/configure roles, assign users, set AD filters), Account Mappings (discover unmapped AD accounts, create/delete mappings, test rotation), and Checkout Requests (status dashboard).
  - **Approvals Page**: Dedicated page for pending password checkout approval decisions. "Request Checkout" and "My Checkouts" tabs moved to the Credentials page for a more logical workflow.
  - **Credentials Page**: Now has three tabs — Profiles, Request Checkout, and My Checkouts — consolidating all credential-related actions in one place.
  - **AD Sync Config**: 11 new optional PM fields (pm_enabled, pm_bind_user, pm_bind_password, pm_target_filter, 5 password policy fields, pm_auto_rotate_enabled, pm_auto_rotate_interval_days) on create/update.
- **AD Sync Password Management UI**: Collapsible "Password Management" section within the AD Sync editing form with: PM enable toggle, service account credential source radio (use AD source bind creds or separate PM-specific creds), target account LDAP filter, password generation policy (min length, uppercase/lowercase/numbers/symbols toggles), auto-rotation enable with configurable interval, and test rotation button.
- **Target Account Filter Preview**: "Preview" button next to the target account filter input that live-tests the LDAP filter against Active Directory and displays matching accounts in a results table (account name, distinguished name, description). Shows up to 25 results with a total count. New `POST /api/admin/ad-sync-configs/test-filter` endpoint.
- **Account Mappings Redesign**: Unified flow replacing the previous two-card layout — select a PM-enabled AD source from a dropdown, auto-discover accounts, then map them to Strata users via dropdowns with optional self-approve checkbox.
- **Connection Health Checks**: Automatic background TCP probing of all connections every 2 minutes. Each connection's hostname:port is tested with a 5-second timeout, and the result (online/offline/unknown) is stored in the database and exposed via the API.
  - **Migration**: `042_connection_health.sql` adds `health_status` and `health_checked_at` columns to the `connections` table.
  - **Backend Worker**: New `health_check.rs` service with concurrent TCP probes across all non-deleted connections.
  - **Dashboard UI**: Green (online), red (offline), or gray (unknown) status dot indicator on each connection row in the table view and on recent connection cards. Hover tooltip shows the last check timestamp.
  - **Status Column**: New "Status" column in the connections table header.

### Improved
- **Styled Radio Buttons**: Custom `.radio` CSS class matching the existing `.checkbox` design system — purple gradient when selected, white inner dot, same sizing/shadows/transitions as checkboxes. Applied to the AD Sync PM credential source selector.

## [0.16.3] — 2026-04-17

### Added
- **Display Tags for Active Sessions**: Users can now pin a single tag per connection to display as a colored badge on session thumbnails in the Active Sessions sidebar. A tag picker dropdown (accessible via a tag icon on each thumbnail) lets users choose from their existing tags or clear the selection. The display tag is persisted per-user per-connection and synced with the backend. This is fully optional — connections without a display tag show no badge.
- **Display Tags API**: Three new endpoints manage display tag assignments:
  - `GET /api/user/display-tags` — returns all display tag mappings as `{ connection_id: { id, name, color } }`
  - `POST /api/user/display-tags` — sets or replaces the display tag for a connection (one per connection per user)
  - `DELETE /api/user/display-tags/:connection_id` — removes the display tag for a connection
- **Display Tags Migration**: New `user_connection_display_tags` table (`040_display_tags.sql`) with a composite primary key on `(user_id, connection_id)` ensuring at most one display tag per connection per user. Foreign keys cascade to `users`, `connections`, and `user_tags`.

## [0.16.2] — 2026-04-17

### Added
- **Command Palette (Ctrl+K)**: A new quick-launch overlay accessible via `Ctrl+K` while connected to any session. Searches all available connections by name, protocol, hostname, description, or folder. Arrow key navigation, Enter to launch, Escape to close. Shows an "Active" badge on already-connected sessions. Also works from pop-out and multi-monitor windows (relayed to the main window via `postMessage`).
- **Keyboard Shortcut Proxy (Ctrl+Alt+`)**: Pressing `Ctrl+Alt+`` sends `Win+Tab` (Task View) to the remote session. This is the only reliable browser-level proxy shortcut — Windows intercepts `Ctrl+Alt+Tab` before JavaScript can capture it.
- **Windows Key Proxy (Right Ctrl)**: Right Ctrl is remapped to the Super/Win key for the remote session. Hold Right Ctrl + another key to send Win+key combos (e.g. Win+E, Win+R). Tap Right Ctrl alone to open the Start menu. Works in single sessions, pop-outs, and multi-monitor windows.
- **Keyboard Lock API (Fullscreen + HTTPS)**: When a session is in fullscreen mode over HTTPS, the browser captures OS-level shortcuts (Win, Alt+Tab, Escape) directly via the Keyboard Lock API and forwards them to the remote session — no proxy keys needed.
- **Conditional Quick Share Button**: The Quick Share upload button in the Session Bar is now only visible when the connection has file transfer enabled (`enable-drive` or `enable-sftp`). Previously it was always shown regardless of the connection configuration.
- **File Transfer Enabled API Field**: The `/user/connections/:id/info` endpoint now returns `file_transfer_enabled: bool`, derived from the connection's `enable-drive` and `enable-sftp` extra settings.

### Improved
- **Session Bar Keyboard Help**: The Session Bar keyboard popover now shows a full mapping reference: Right Ctrl → Win key, Right Ctrl + key → Win+key, Ctrl+Alt+` → Win+Tab, Ctrl+K → Quick Launch. Includes explanatory notes about Right Ctrl+Tab browser interception and the fullscreen HTTPS tip.
- **Session Bar Quick Tools**: Shortcut buttons for Alt+Tab, Win+Tab, and Ctrl+Alt+T (Terminal) are available in the Session Bar for one-click sending of common key sequences to the remote session.

## [0.16.1] — 2026-04-17

### Improved
- **Multi-Monitor Rendering Fix**: Secondary monitor windows now render correctly using the default layer's canvas reference (`getCanvas()`) instead of `display.flatten()`, which allocated a new full-resolution canvas every frame (~600 MB/s of GC pressure at 30 fps) and caused black screens by starving the Guacamole rendering pipeline.
- **Multi-Monitor Render Loop**: Replaced `requestAnimationFrame` with `setInterval` (33 ms / ~30 fps) for the secondary window render loop. `requestAnimationFrame` is throttled or paused entirely by the browser when the main window loses focus to a popup, which happens immediately when the user interacts with a secondary monitor window.
- **Multi-Monitor Cursor Sync**: The remote cursor (arrow, resize handle, text beam, etc.) is now visible on all secondary monitors. A `MutationObserver` watches the Guacamole display element's CSS `cursor` property and mirrors it to every secondary canvas in real time.
- **Multi-Monitor Horizontal Layout**: All monitors are now placed in a flat horizontal row (sorted left-to-right by physical position) regardless of vertical offsets. Because guacd sends a single aggregate resolution to the remote desktop, the remote OS places the taskbar at the very bottom of the aggregate. Using vertical offsets from mixed arrangements (e.g. a portrait monitor offset lower) would push the aggregate height beyond the landscape monitors' visible area, making the taskbar unreachable.
- **Multi-Monitor Primary Height Cap**: The aggregate remote resolution height is capped to the primary monitor's height. This ensures the taskbar remains visible within the primary monitor's slice. Taller secondary monitors (e.g. portrait) display the primary-height region of the remote desktop with black fill below.
- **Multi-Monitor Auto-Maximize**: Secondary popup windows now call `moveTo()` + `resizeTo()` after opening to fill their target screen, and attempt `requestFullscreen()` for a chrome-free view.
- **Pop-out Screen-Change Detection**: Single pop-out windows now detect when dragged to a different screen via polling `screenX`/`screenY`/`devicePixelRatio` (250 ms interval, 300 ms debounce). After the position settles, the display is re-scaled and `sendSize()` is called with the new window dimensions.
- **Pop-out Resize Handler**: The pop-out window's `display.onresize` callback now uses `setTimeout` instead of `requestAnimationFrame` to avoid being throttled when the popup has focus and the main window is backgrounded.

### Multi-Monitor Usage Notes
Multi-monitor mode works by sending a single aggregate resolution to the remote desktop via guacd. The remote OS (Windows/Linux) sees this as one large display, not separate monitors. This has important implications:

- **Best supported**: All landscape monitors arranged left-to-right in a horizontal row. Each monitor gets its own browser window showing its slice of the remote desktop.
- **Portrait monitors**: A portrait monitor's slice width is narrower but the height is capped to the primary monitor's height. The extra vertical space shows black — the remote desktop doesn't extend into it.
- **Monitors above/below**: Vertical monitor arrangements are flattened into a horizontal row. A monitor physically above or below the primary will appear as a slice to the right. You would need to scroll/move the mouse rightward through the aggregate desktop to reach the content shown on that monitor.
- **Taskbar visibility**: The remote taskbar always appears at the bottom of the aggregate resolution, which is capped to the primary monitor's height. This keeps it visible on same-height landscape monitors.

## [0.16.0] — 2026-04-17

### Security
- **Granular Permission Enforcement**: All ~30 admin API endpoints now enforce granular permission checks (`can_manage_system`, `can_manage_users`, `can_manage_connections`, `can_view_audit_logs`, `can_view_sessions`) instead of relying solely on `require_admin` middleware. A `can_manage_system` flag acts as a super-admin bypass. This prevents users with limited admin roles from accessing endpoints beyond their permissions.
- **Tunnel Ticket User Validation**: After consuming a one-time tunnel ticket, the backend now verifies that the authenticated user matches the ticket's `user_id`, preventing ticket theft if a token is intercepted.
- **Credential Zeroization on Drop**: `TunnelTicket` now implements `Drop` with `zeroize` to scrub username and password fields from memory when the ticket goes out of scope, closing a window where credentials could linger after tunnel establishment.
- **Refresh Token Re-reads Role from DB**: The `/api/auth/refresh` endpoint now queries the database for the user's current role instead of copying stale claims from the old JWT. Role changes (e.g. demotion) are now effective immediately on the next token refresh.
- **Admin Tag Color Validation**: The `create_admin_tag` and `update_admin_tag` endpoints now validate that color values are valid hex codes (`#rgb` or `#rrggbb`), preventing storage of arbitrary strings.
- **User Tag Color Validation**: The `create_tag` and `update_tag` user endpoints now enforce the same hex color validation.
- **Accept Terms Version Bounds**: The `accept_terms` endpoint now rejects version numbers outside the 1–1000 range.
- **Connection Share Expiry Constraint**: Migration 038 adds a `NOT NULL` constraint to `connection_shares.expires_at`, ensuring all share links have an expiry. Existing NULL rows are backfilled with a 24-hour default.

### Improved
- **Multi-Monitor 2D Layout**: Multi-monitor mode now uses physical screen coordinates directly from the Window Management API to build a true 2D aggregate layout, correctly handling stacked, L-shaped, and mixed-resolution monitor arrangements. Previously all screens were forced into a horizontal row regardless of physical placement.
- **Multi-Monitor Display Scaling**: The primary monitor now explicitly sets `display.scale()` immediately after requesting the aggregate resolution, rather than relying on an asynchronous resize handler. This eliminates the brief flash of incorrect scaling when entering multi-monitor mode.
- **Multi-Monitor Re-attach Guard**: `attachSession()` no longer overrides multi-monitor scaling when React re-renders trigger a session re-attach (e.g. clipboard sync, sidebar toggle). Multi-monitor sessions manage their own display scale independently.
- **Non-blocking File Store I/O**: All `std::fs` calls in the session file store have been replaced with `tokio::fs` equivalents. The `RwLock` is now released before performing disk I/O and re-acquired afterward, eliminating async runtime blocking during file uploads, downloads, and cleanup.
- **Non-blocking Kerberos Config Write**: The `write_krb5_conf_multi` call in `regenerate_krb5_conf` is now wrapped in `tokio::task::spawn_blocking`, preventing the synchronous file write from blocking the async runtime.
- **Settings Cache Pruning**: The in-memory settings cache now prunes stale entries when the cache exceeds 500 items, preventing unbounded memory growth from unique key lookups.
- **Session Stats Single-Query CTE**: The recordings session stats endpoint now executes a single CTE-based query instead of six separate aggregate queries, reducing database round-trips.
- **Session Stats Static SQL**: All `format!`-interpolated SQL in session stats has been replaced with static string literals using `NOW() - INTERVAL '30 days'`, eliminating potential injection vectors.
- **Update Role Single COALESCE Query**: The `update_role` endpoint now uses a single `UPDATE ... SET col = COALESCE($n, col)` query instead of up to 11 individual UPDATE statements per field.
- **Update Kerberos Realm Single Query**: The `update_kerberos_realm` endpoint now uses a single COALESCE-based UPDATE instead of up to 7 individual field updates.
- **Set Connection Tags Bulk Insert**: Both `set_connection_tags` (user) and `set_admin_connection_tags` (admin) now use `INSERT ... SELECT unnest($1::uuid[])` for bulk tag assignment instead of N+1 individual inserts.
- **Set Connection Tags Transaction**: The user `set_connection_tags` endpoint now wraps the delete+insert in a database transaction to prevent inconsistent state on partial failure.
- **Credential Profile Consolidation**: The `update_credential_profile` endpoint now uses at most two conditional UPDATE queries (with COALESCE) instead of three separate paths, reducing code duplication and database round-trips.
- **IP Extraction Consolidation**: All inline X-Forwarded-For header extraction (tunnel, share, user endpoints) now uses a shared `extract_client_ip` / `try_extract_client_ip` helper from the auth module.

### Fixed
- **Role-Based Access Replaces String Comparison**: All `user.role == "admin"` / `user.role != "admin"` string checks in tunnel, share, and user routes have been replaced with permission-based methods (`can_access_all_connections()`, `can_manage_system`, etc.), fixing a class of bugs where custom roles with connection management permissions were incorrectly blocked.
- **Delete Tag Returns 404**: The `delete_tag` endpoint now checks `rows_affected()` and returns a proper 404 instead of a silent 200 when the tag doesn't exist.
- **Update Tag Returns 404**: The `update_tag` endpoint now uses `fetch_optional` + `ok_or_else` instead of `fetch_one`, returning a 404 instead of a 500 when the tag doesn't exist.
- **JSON Serialization Panic**: Two `.unwrap()` calls on `serde_json::to_string` in the auth module have been replaced with proper error propagation, preventing a theoretical panic on serialization failure.

### Database
- **Migration 039**: Adds `idx_users_deleted_at` (partial index on soft-deleted users), `idx_user_connection_access_conn_user` (composite index for connection access checks), and `NOT NULL` constraint on `connection_shares.expires_at`.

## [0.15.3] — 2026-04-16

### Added
- **Quick Share (Temporary File CDN)**: Upload files from the Session Bar and get a random, unguessable download URL to paste into the remote session's browser. Files are stored in-memory + disk on the backend, scoped to the active session, and automatically deleted when the tunnel disconnects. Supports drag-and-drop, multiple files (up to 20 per session, 500 MB each), copy-to-clipboard URLs, and per-file delete. No authentication required on the download endpoint — the random token is the capability.
- **Multi-Monitor Screen Count**: The multi-monitor button tooltip now shows the number of detected screens (e.g. "Multi-monitor (3 screens detected)"), updating live when monitors are plugged in or out.

### Fixed
- **Quick Share Upload Size Limit — Nginx (413)**: Uploading files larger than 10 MB to Quick Share returned HTTP 413 (Content Too Large) because nginx's `client_max_body_size` was set to `10M`. Increased the limit to `500M` to match the backend's per-file cap, and raised `client_body_timeout` from 10 s to 300 s so large uploads don't time out mid-transfer.
- **Quick Share Upload Size Limit — Axum (413)**: Even after the nginx fix, uploads over 2 MB still failed because Axum's default multipart body limit is 2 MB. Added an explicit `DefaultBodyLimit::max(500 MB)` layer on the upload route to match the backend's per-file cap.
- **Quick Share Delete "Unexpected end of JSON input"**: Deleting a Quick Share file threw a client-side JSON parse error because the backend returns an empty 200 response. The `request()` helper now reads the response as text first and only parses JSON when the body is non-empty.
- **Multi-Monitor 3+ Screens — Live Screen Detection**: Connecting three or more monitors only opened one popup window. The `getScreenDetails()` API returns a **live** `ScreenDetails` object, but the code read it once on mount and cached the snapshot. If the third monitor wasn't detected at that instant — or screens changed later — the cache was stale. The hook now stores the live `ScreenDetails` object, listens for the `screenschange` event, and refreshes the screen layout whenever monitors are plugged in or out.
- **Multi-Monitor 3+ Screens — Popup Blocker**: Even with live screen detection, the second and subsequent popups were blocked by Chrome's popup blocker. Chrome only allows multiple `window.open()` calls within a single user gesture if `getScreenDetails()` is called during that gesture to signal multi-screen intent. The hook now calls `await getScreenDetails()` inside the click handler, which extends Chrome's user activation through the await and permits all secondary window opens.
- **Disclaimer Modal Scroll-to-Accept on Tall Screens**: The "I Accept" button on the Session Recording Disclaimer was permanently disabled on screens tall enough to display the full terms without scrolling, because the scroll event never fired. The modal now checks on mount whether the content fits without overflow and enables the button immediately when it does. A `ResizeObserver` re-checks on viewport changes.

## [0.15.0] — 2026-04-16

### Improved
- **Multi-Monitor Brave / Fingerprinting Compatibility**: The Window Management API `getScreenDetails()` returns zeroed screen dimensions and positions in Brave and other privacy-focused browsers. Multi-monitor mode now falls back to `window.screen` dimensions for any screen reporting zero width/height, and computes popup placement from cumulative tile offsets instead of relying on physical screen coordinates.
- **Multi-Monitor Primary Resolution**: The primary monitor slice now uses the actual browser container dimensions instead of the physical screen resolution, preserving 1:1 scale identical to single-monitor mode.
- **Secondary Window Dynamic Resize**: Secondary monitor windows now adapt their canvas backing store when resized, stretching the remote desktop slice to fill the window.
- **Secondary Window Cursor Visibility**: The OS cursor is now visible in secondary monitor windows, instead of being hidden with `cursor: none`.

## [0.14.9] — 2026-04-16

### Added
- **Browser-Based Multi-Monitor for RDP**: Span a remote desktop session across multiple physical monitors using the Window Management API (Chromium 100+). When enabled, the session resolution is dynamically expanded to cover all detected screens and each secondary monitor receives its own browser window showing the correct slice of the remote desktop via `requestAnimationFrame` canvas blitting. Mouse input in secondary windows is offset-translated so coordinates map correctly to the aggregate remote resolution. Keyboard input (including the Windows key proxy) is forwarded from all windows. A new multi-monitor toggle button appears in the Session Bar alongside the existing Pop-out button. Gracefully no-ops on browsers without `getScreenDetails()` support.

## [0.14.8] — 2026-04-16

### Fixed
- **Remote Display Resize Breaking Session View**: When the remote desktop's resolution changed (e.g., maximising a window inside an RDP session), the Guacamole display was not rescaled to fit the browser container, resulting in an unreadable, incorrectly-scaled display. Added a `display.onresize` handler in both the main session view and pop-out windows so the display is automatically rescaled whenever the remote resolution changes.

## [0.14.7] — 2026-04-16

### Added
- **Live Session Sharing (View & Control)**: Share links now observe the owner's live session in real time via the NVR broadcast channel, instead of opening an independent connection. Shared viewers see exactly what the owner sees. Control mode share links forward keyboard and mouse input to the owner's session via an injected mpsc channel.
- **Public Display Settings Endpoint**: New `GET /api/user/display-settings` endpoint returns only the three display-related settings (timezone, time format, date format) without requiring admin privileges, eliminating 403 errors for non-admin users.
- **Admin Tags**: Administrators can create system-wide tags and assign them to connections for organizational categorization. Tags are visible (read-only) to all users on the Dashboard alongside their existing personal tags.

### Fixed
- **Share Link "Connection Failed"**: Share links returned a 500 error because the `connection_shares` table was missing `access_count` and `last_accessed` columns referenced in an UPDATE query. Removed the nonexistent column reference.
- **Share Link Showing Login Screen**: Shared sessions opened an independent RDP connection (showing the remote server's login screen) instead of viewing the owner's active session. Rewrote the share tunnel to subscribe to the owner's NVR broadcast, showing the same screen the owner sees.
- **Share Button Missing from Session Bar**: The share button was not visible because `SessionManagerProvider` called `getMe()` in a one-shot `useEffect` that ran before authentication completed and never re-ran. Changed `canShare` to a reactive prop derived from the authenticated user's permissions in `App.tsx`.
- **403 on Settings Load for Non-Admin Users**: `SettingsContext` called the admin-only `GET /api/admin/settings` endpoint. Switched to the new public `GET /api/user/display-settings` endpoint.
- **Tag Dropdown Going Off-Screen**: Tag menu used `position: absolute` which was clipped by parent overflow. Changed to `position: fixed` with viewport-calculated coordinates via `getBoundingClientRect()`.
- **User Deletion Blocked by Audit Logs**: Hard-deleting users failed because `audit_logs.user_id` had no `ON DELETE` clause (defaulting to RESTRICT). Added migration 037 to set `ON DELETE SET NULL`.
- **Recording Files Orphaned on User Deletion**: Physical recording files (local and Azure Blob) were not deleted during user hard-delete. The cleanup task now purges local files and Azure blobs before cascading the database delete.

## [0.14.6] — 2026-04-16

### Added
- **Recording Disclaimer / Terms of Service**: First-time users are presented with a full-screen disclaimer modal covering session recording, consent, acceptable use, and data protection. Users must scroll to the bottom and explicitly accept before accessing the application. Declining logs the user out. Acceptance is recorded with a timestamp in the database and is not shown again on subsequent logins.
- **NVR Play/Pause**: The NVR live session player now has a play/pause toggle button. Pausing freezes the display while the WebSocket stream stays connected, so no data is lost. Resuming picks up from the current live point.

## [0.14.5] — 2026-04-16

### Fixed
- **NVR Live Rewind Black Screen**: Rewinding a live session (30s, 1m, 3m, or 5m) would display a black screen because the backend sent intermediate `sync` instructions during the replay phase, causing the Guacamole client to queue hundreds of intermediate frames. Sync instructions are now suppressed during replay and a single sync is sent after all drawing operations, rendering the target frame atomically.
- **NVR Player Default Speed**: The NVR player now defaults to 1× speed instead of 4× when first opened.
- **NVR Speed Change During Live Phase**: Changing playback speed while watching a live session no longer triggers an unnecessary reconnect. Speed changes during the live phase are applied in-place.
- **Popout Window Close Reconnect**: Closing a popped-out session window no longer leaves a white screen on the main page. The display element is adopted back into the main document and the user is navigated to the session page.

## [0.14.4] — 2026-04-15

### Added
- **Recording Player Skip Controls**: Skip forward and back by 30 seconds, 1 minute, 3 minutes, or 5 minutes during recording playback. Seeking disconnects and reconnects at the target position, with a loading indicator while the backend fast-forwards.
- **Recording Player Speed Controls**: Play recordings at 1×, 2×, 4×, or 8× speed. Speed changes reconnect at the current position with the new playback rate.

### Fixed
- **Recording Playback Freezing During Idle Periods**: Recordings that contained long idle gaps (no screen updates) would freeze the progress bar and then jump forward. The backend now sends interpolated progress updates every 500 ms during pacing sleep, and the CSS progress bar uses a smooth linear transition.
- **Black Screen on Seek/Rewind**: Seeking to a position in a recording would show a black screen or fast-replay artefact because the backend was sending intermediate `sync` instructions during the seek phase, causing the Guacamole client to queue hundreds of frames. The backend now suppresses `sync` instructions while seeking so all drawing operations accumulate into a single atomic frame at the target position.

## [0.14.3] — 2026-04-15

### Added
- **Recording Player Fullscreen Mode**: The historical recording player now has a fullscreen toggle button in both the header bar and a dedicated CSS class for true full-viewport playback. The default modal width has also been increased from `max-w-5xl` to `max-w-7xl` for a larger viewing area.
- **Live/Rewind for Own Sessions**: Users with the `can_view_sessions` permission can now observe and rewind their own live sessions — not just admins. A new user-scoped WebSocket endpoint (`GET /api/user/sessions/:id/observe`) verifies session ownership before allowing observation.

### Changed
- **NVR Observe Route Guard**: The `/observe/:sessionId` frontend route now also allows users with `can_view_sessions`, matching the new user-scoped observe endpoint.
- **Sessions Page Actions Column**: The Live and Rewind buttons are now visible for all users who can see the Sessions page. Admin users connect via the admin endpoint; regular users connect via the user-scoped endpoint automatically.

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
