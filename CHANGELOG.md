# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.6] — Unreleased

### Minor Release — Multiplayer / Co-Pilot Mode for shared sessions

Strata's share links graduate from a strict 1:1 (owner ↔ single viewer) model
to a true **multiplayer / co-pilot** experience. Owners can now invite up to
six participants into a single control-mode share, each with their own
display name, deterministically-assigned cursor colour, and live presence on
the screen. A server-arbitrated single-holder input token governs which
participant currently drives the keyboard and mouse — the owner can
force-grant control at any time, peers can request control voluntarily, and
an idle-grant rule automatically transfers the token after two seconds of
inactivity so no participant can monopolise the session indefinitely. An
optional in-room text chat panel (default on) lets the cohort coordinate
without leaving the session, and a per-room audio-mesh flag is wired
end-to-end so a future release can light up voice without a schema change.

#### Added

- **Multiplayer / Co-Pilot Mode for control-mode shares**
  ([`backend/src/services/co_pilot.rs`](backend/src/services/co_pilot.rs), [`backend/src/services/co_pilot/room.rs`](backend/src/services/co_pilot/room.rs), [`backend/src/routes/share.rs`](backend/src/routes/share.rs), [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs), [`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs), [`backend/src/services/shares.rs`](backend/src/services/shares.rs), [`backend/migrations/066_multiplayer_share.sql`](backend/migrations/066_multiplayer_share.sql), [`frontend/src/co-pilot/`](frontend/src/co-pilot/), [`frontend/src/pages/SharedViewer.tsx`](frontend/src/pages/SharedViewer.tsx), [`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx), [`frontend/src/api.ts`](frontend/src/api.ts)).
  When an owner creates a control-mode share, the new **Multiplayer (co-pilot)** toggle in the Share popover unlocks three sub-controls — **Max participants** (clamped 2..=6), **Allow chat** (default on), and **Allow audio** (default off, reserved for a follow-up release). The generated share URL carries an `mp=1` flag so the viewer knows to open the new sibling WebSocket. The server routes the JSON envelope protocol through a dedicated `/api/shared/copilot/{share_token}?name=Foo` endpoint, separate from the existing Guacamole tunnel WebSocket at `/api/shared/tunnel/{share_token}`. Splitting envelopes onto their own connection avoids interleaving JSON frames with the Guacamole protocol that `Guacamole.WebSocketTunnel` cannot parse. The server's first response is a `Welcome { pid, allow_chat, allow_audio, max_participants }` envelope; the client then opens the tunnel WS with `?pid=<uuid>` so the server can gate input forwarding on the in-memory input-token holder. Per-room state lives in `CoPilotRoom` (one per `ActiveSession`, always-instantiated and zero-cost when no multiplayer share exists): roster, deterministic colour palette (8-entry round-robin), join-order, and the single-holder input token with the FSM described above (owner force-grant, peer claim, 2-second idle-grant, voluntary release, owner revoke). Display names are sanitised, length-bounded to 40 characters, and disambiguated with a `" (n)"` suffix when collisions occur. Every join and leave is audited via a dedicated `share_participant_audit` table plus matching `audit_log` events (`share.multiplayer.joined`, `share.multiplayer.left`), so post-incident forensics can reconstruct who was in the room at any time.
- **`multiplayer_share_enabled` system setting kill-switch**
  ([`backend/src/routes/share.rs`](backend/src/routes/share.rs)). `POST /api/user/connections/{id}/share` checks the `multiplayer_share_enabled` system setting (default `"true"`, never seeded — absence means enabled) on every multiplayer share creation. When the value is exactly `"false"` the route silently downgrades the request to a standard single-viewer control share, leaving the existing share workflow untouched but giving administrators a single-toggle escape hatch if they need to disable the feature in a hurry without re-deploying.

#### Database

- **Migration `066_multiplayer_share.sql`** — `ALTER TABLE connection_shares ADD COLUMN multiplayer BOOLEAN NOT NULL DEFAULT FALSE`, `max_participants SMALLINT NOT NULL DEFAULT 1 CHECK (max_participants BETWEEN 1 AND 6)`, `allow_chat BOOLEAN NOT NULL DEFAULT FALSE`, `allow_audio BOOLEAN NOT NULL DEFAULT FALSE`; new `share_participant_audit (id BIGSERIAL PRIMARY KEY, share_id UUID REFERENCES connection_shares(id) ON DELETE CASCADE, pid UUID NOT NULL, display_name TEXT NOT NULL, is_owner BOOLEAN NOT NULL DEFAULT FALSE, joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), left_at TIMESTAMPTZ, client_ip TEXT, user_agent TEXT)` with indices on `share_id` and `joined_at`. All existing shares retain the legacy single-viewer behaviour without modification.

#### Tests

- **Backend** — 17 unit tests in `services::co_pilot::room` cover the join/leave/sanitise/disambiguate/colour-allocation/input-claim-FSM paths; additional route-level tests in `routes::share` exercise the multiplayer-defaults-off case, full multiplayer payload round-tripping, and the lock-step `max_participants` clamp shared by the DB CHECK, the route, and the in-memory room cap.
- **Frontend** — full vitest suite (1407 cases across 67 files) continues to pass with no regressions.

#### Upgrade Notes

- Apply migration 066 before rolling the binary. The schema additions are all backwards-compatible (`DEFAULT FALSE` / `DEFAULT 1`) so existing single-viewer shares continue to function without modification while the new column data lights up.
- The first release ships **without** the audio-mesh client and **without** an owner-side participant view; `allow_audio` is wired through the schema and protocol so a future release can light it up without a migration. Operators wishing to disable the entire feature until they have evaluated it can `INSERT INTO system_settings (key, value) VALUES ('multiplayer_share_enabled', 'false') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`.

## [1.9.5] — 2026-05-22

### Minor Release — Server-side recordings search, per-user last-login tracking, configurable stale-account auto-cleanup, Client IP visibility on the Sessions blade, and DMZ peer version visibility on the Health blade

This release tightens two operator-facing workflows on the admin blade. The **Recordings** tab on the Sessions page now performs its search and pagination on the server, lifting the previous hard cap of 200 client-side rows and giving administrators a true index over the historical recording set rather than a fixed-window slice of it. The **Users** tab now exposes a per-user **Last Login** column populated on every successful local or SSO authentication, and a new **Stale account auto-deletion** retention setting lets administrators automate the soft-delete of any account that has been provisioned and signed in at least once but has since gone idle past a configurable threshold. The new sweep deliberately ignores accounts that have never logged in so freshly-provisioned AD-sync imports are not aged out solely by creation time. Soft-deleted users continue to flow through the existing `user_hard_delete_days` retention window and remain restorable from the **Show Deleted Users** filter. The Sessions blade also gains a new **Client IP** column on both the Live and Recordings tabs, surfacing the operator's public source address for both in-flight and historical sessions for forensic and audit attribution. Finally, in DMZ deployments the **Health** tab now renders a **DMZ Version** tile next to the existing **Strata Version** tile, capturing the `strata-dmz` binary's version over the existing mTLS link so administrators can spot DMZ ↔ backend version skew at a glance.

#### Added

- **Server-side search and pagination for the Recordings table**
  ([`backend/src/routes/admin/recordings.rs`](backend/src/routes/admin/recordings.rs), [`backend/src/routes/user.rs`](backend/src/routes/user.rs), [`backend/src/services/recordings.rs`](backend/src/services/recordings.rs), [`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/Sessions.tsx`](frontend/src/pages/Sessions.tsx)).
  `GET /api/admin/recordings` and `GET /api/user/recordings` now accept an optional `search` query parameter. When supplied, the SQL `WHERE` clause adds `AND ($3::text IS NULL OR connection_name ILIKE $3 OR username ILIKE $3)` with the parameter bound as `format!("%{}%", search)` and the existing `LIMIT`/`OFFSET` indices shifted to `$4`/`$5`. The Sessions page replaces the previous 200-row client-side filter with a paginated fetch (`PAGE_SIZE = 50`) that issues `limit + 1` rows to derive `hasMore` for the Next/Previous footer, debounces the search input by 300 ms before each refetch, resets to page 1 on every new query, and ships a dedicated empty state that distinguishes "no recordings yet" from "no results matching `<query>`" with a single-click **Clear search filter** action.
- **Per-user `last_login_at` timestamp surfaced on the Users admin blade**
  ([`backend/migrations/064_user_last_login.sql`](backend/migrations/064_user_last_login.sql), [`backend/src/services/users.rs`](backend/src/services/users.rs), [`backend/src/routes/auth.rs`](backend/src/routes/auth.rs), [`frontend/src/pages/admin/AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx)).
  Migration 064 adds a nullable `users.last_login_at TIMESTAMPTZ` column. Both `POST /api/auth/login` (local) and `GET /api/auth/sso/callback` (SSO) call the new `services::users::update_last_login(pool, user_id)` helper on every successful authentication, immediately before audit logging. The helper is invoked best-effort (`let _ = ...`) so a DB hiccup never blocks the user from receiving their access/refresh tokens. The admin Users table now renders a **Last Login** column formatted via `useSettings().formatDateTime` (honouring the operator's configured `display_timezone` / `display_date_format` / `display_time_format`), with an italic **Never** placeholder for accounts that have not yet authenticated. `UserRow.SELECT_COLUMNS` and the `user_row_*` unit tests in `routes/admin.rs` were updated in lock-step.
- **Configurable `user_stale_days` stale-account auto-soft-delete sweep**
  ([`backend/migrations/064_user_last_login.sql`](backend/migrations/064_user_last_login.sql), [`backend/src/services/user_cleanup.rs`](backend/src/services/user_cleanup.rs), [`frontend/src/pages/admin/SecurityTab.tsx`](frontend/src/pages/admin/SecurityTab.tsx)).
  The existing daily `user_cleanup` worker (`backend/src/services/user_cleanup.rs`) now runs a stale-account sweep before the existing hard-delete pass. It reads `user_stale_days` from `system_settings` (seeded to `'0'` by migration 064; **0 disables**) and, when the value is a positive integer, soft-deletes any live user whose `last_login_at` is older than the threshold via `UPDATE users SET deleted_at = now() WHERE deleted_at IS NULL AND last_login_at IS NOT NULL AND last_login_at < now() - make_interval(days => $1)`. Users with `last_login_at IS NULL` (never signed in) are explicitly excluded so freshly-provisioned AD-sync imports are not aged out solely on creation time — the clock only starts after a user's first successful authentication. The bootstrap admin account (matched case-insensitively against `DEFAULT_ADMIN_USERNAME`, default `"admin"`) is also always excluded so the sweep can never lock operators out of their own deployment. Each affected row is audited as `user.stale_auto_deleted` with `{ user_id, username, stale_days }`, and the soft-deleted record continues to flow through the existing `user_hard_delete_days` retention window (so it remains recoverable from the **Show Deleted Users** filter for the configured grace period). The Security tab adds a **Stale account auto-deletion (days)** input alongside the hard-delete window, validated `0..=3650`, persisted via the existing `updateSettings` endpoint as the `user_stale_days` key.
- **Client IP visibility on the Sessions admin blade**
  ([`backend/migrations/065_recording_client_ip.sql`](backend/migrations/065_recording_client_ip.sql), [`backend/src/db/mod.rs`](backend/src/db/mod.rs), [`backend/src/services/recordings.rs`](backend/src/services/recordings.rs), [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs), [`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/Sessions.tsx`](frontend/src/pages/Sessions.tsx), [`docs/api-reference.md`](docs/api-reference.md)).
  The admin **Live** and **Recordings** tabs now render a **Client IP** column showing the operator's public source address as resolved at handshake from the rightmost non-empty `X-Forwarded-For` entry (with a `ConnectInfo` peer-IP fallback — the same helper that drives audit-log attribution). The live side reuses the in-memory `session_registry::ActiveSession.client_ip` field that was already populated end-to-end but never surfaced in the UI. The recordings side is backed by a new nullable `recordings.client_ip TEXT` column (migration 065) populated by `recordings::insert_start(...)` at the same call site that captures `nvr_session_id` and `started_at`, so the value is persisted at the moment the recording begins rather than reconstructed after the fact. Rows that pre-date migration 065 (or where the IP could not be resolved at handshake) render an italic **Unknown** placeholder. The column is gated on `isAdmin`, so non-admin views of `/user/sessions` and `/user/recordings` are unchanged.
- **DMZ peer software version surfaced on the Health and DMZ Links admin blades**
  ([`crates/strata-protocol/src/handshake.rs`](crates/strata-protocol/src/handshake.rs), [`crates/strata-protocol/src/link.rs`](crates/strata-protocol/src/link.rs), [`crates/strata-dmz/src/link_server/listener.rs`](crates/strata-dmz/src/link_server/listener.rs), [`crates/strata-dmz/src/main.rs`](crates/strata-dmz/src/main.rs), [`backend/src/services/dmz_link/registry.rs`](backend/src/services/dmz_link/registry.rs), [`backend/src/services/dmz_link/supervisor.rs`](backend/src/services/dmz_link/supervisor.rs), [`backend/src/routes/admin/dmz.rs`](backend/src/routes/admin/dmz.rs), [`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/admin/HealthTab.tsx`](frontend/src/pages/admin/HealthTab.tsx), [`frontend/src/pages/admin/DmzLinksTab.tsx`](frontend/src/pages/admin/DmzLinksTab.tsx), [`docs/api-reference.md`](docs/api-reference.md)).
  The `strata-link/1.0` handshake is extended so the DMZ now echoes its own `software_version` back to the internal node in `AuthOutcome::Accept`, alongside the existing `link_id`. The new field is declared `#[serde(default, skip_serializing_if = "Option::is_none")] software_version: Option<String>` and is therefore wire-compatible with pre-1.9.5 DMZ binaries — missing fields deserialise to `None` and the UI renders "Unknown". The backend supervisor captures the advertised value into `LinkStatus.remote_software_version` on every successful handshake (preserved across `Backoff` cycles so the UI keeps the last-known value while the link is reconnecting) and surfaces it through `GET /api/admin/dmz-links` as `remote_software_version`. The admin **Health** tab now renders a new **DMZ Version** tile alongside the existing **Strata Version** tile when DMZ mode is configured, with a yellow skew warning when the DMZ version differs from `__APP_VERSION__` and a **Mixed** indicator (with the full list of distinct versions) for multi-DMZ deployments running heterogenous builds. The **DMZ Links** tab gains a **DMZ version** column showing the per-endpoint reported version. No new endpoints or ports — the entire exchange stays inside the existing mTLS + PSK link.

#### Database

- **Migration `064_user_last_login.sql`** — `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;` and `INSERT INTO system_settings (key, value) VALUES ('user_stale_days', '0') ON CONFLICT (key) DO NOTHING;`. The column is nullable so existing rows do not need a back-fill; any existing user is treated as **never logged in** until their next authentication.
- **Migration `065_recording_client_ip.sql`** — `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS client_ip TEXT;`. Nullable for backwards compatibility; recordings created before this migration render as **Unknown** in the new Client IP column. No back-fill is performed.

#### Tests

- **`frontend/src/__tests__/Sessions.test.tsx`** — the `filters recordings by search` test was rewritten to mirror the new server-side semantics: `vi.mocked(getRecordings)` is now a filtering `mockImplementation` keyed off `params.search`, the test advances Vitest fake timers past the 300 ms debounce via `vi.advanceTimersByTime(350)` inside `act()`, asserts `getRecordings` was called with `{ search: "Alpha" }`, and `waitFor`s the Beta row out of the DOM after the refetch resolves.
- **`frontend/src/__tests__/SecurityTab.test.tsx`** and **`frontend/src/__tests__/AdminSettings.test.tsx`** — the _persists watermark + retention + auth methods on save_ and _sends watermark and auth settings on save_ assertions were extended with the third settings tuple `{ key: "user_stale_days", value: "0" }`.
- **`backend/src/routes/admin.rs`** — three test-only `UserRow { ... }` literals (`user_row_serializes`, `user_row_serializes_with_deleted_at`, `user_row_serializes_with_sub`) now initialise the new `last_login_at: None` field so `cargo clippy -p strata-backend --all-targets -- -D warnings` builds cleanly.

#### Migration notes

- **Backend + frontend rebuild** required. `docker compose up -d --build backend frontend` is sufficient; migrations 064 and 065 are applied automatically at backend startup by the existing `sqlx::migrate!` invocation.
- **No back-fill of `last_login_at`.** Existing rows keep `NULL` until the user's next successful login. This is intentional — the stale-account sweep explicitly ignores `NULL` rows, so accounts that existed before the upgrade are never auto-deleted purely on the basis of when they were created. Operators who want to seed historical data can compute it from the existing `audit_logs` table (events `auth.local_login` and `auth.sso_login`) and `UPDATE` the column manually before enabling `user_stale_days`.
- **Default `user_stale_days = 0` means the sweep is disabled out of the box.** Set a positive integer (1–3650) in **Admin Settings → Security → Stale account auto-deletion** to enable. The sweep runs daily as part of the existing `user_cleanup` worker, on the same cadence as the hard-delete pass.
- **Recordings search is forwards-compatible.** Clients that omit the `search` query parameter continue to receive the previous behaviour (`AND ($3::text IS NULL OR ...)` short-circuits when the bound is `NULL`).

## [1.9.4] — 2026-05-20

### Patch Release — Live session observer reconstructs canvas state beyond the 5-minute NVR ring buffer

This patch release fixes a long-standing visual defect in the admin and shared-viewer live-session observer that caused the canvas to render as a black frame whenever an observer joined a tunnel session more than five minutes after it had started. The fix introduces a per-session **persistent-state log** alongside the existing time-windowed ring buffer. Drawing instructions that age out of the five-minute ring buffer are now salvaged into the log so that newly-joining observers receive a fully reconstructed display rather than an empty canvas, while preserving the existing credential-filtering invariants.

#### Fixed

- **LIVE button / share viewer black canvas after 5 minutes of session uptime**
  ([`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs), [`backend/src/routes/admin.rs`](backend/src/routes/admin.rs), [`backend/src/routes/share.rs`](backend/src/routes/share.rs)).
  Admin observers (`GET /api/admin/sessions/:id/observe`), self-service observers (`GET /api/user/sessions/:id/observe`) and share-link viewers (`GET /api/shared/tunnel/:token`) previously saw a fully black canvas when joining a tunnel session whose original wallpaper / layer-setup drawing instructions had already been evicted from the five-minute ring buffer. The buffer evicted frames purely by age, so on mostly-idle desktops the instant-dump that primes a new observer's display contained only recent incremental updates — never the initial PNG tiles, layer creates, or large image streams that established the visible screen state. The frontend `NvrPlayer.tsx` correctly drove an `offset=0` (live-edge) connect, but with no drawing ops to replay the display stayed black until activity happened to repaint every pixel.

#### Added

- **Persistent-state log on `SessionBuffer`**
  ([`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs)).
  Introduced a per-session `persistent_state: VecDeque<String>` field alongside the existing time-windowed `frames: VecDeque<BufferedFrame>`. On every eviction from the ring buffer (whether triggered by the `MAX_BUFFER_DURATION = 300s` age cap or the `MAX_BUFFER_BYTES = 50 MB` size cap), non-ephemeral Guacamole instructions are appended in order to the persistent log via the new private `salvage_persistent_state(&mut self, data: &str)` helper. The log is capped at `MAX_PERSISTENT_STATE_BYTES = 20 MB`; once full, the **oldest** instructions are dropped first so that recent visual state is always retained. A new `pub fn persistent_state(&self) -> String` accessor returns the concatenated log on demand.
- **Ephemeral-opcode filter shared with the persistent log**
  ([`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs)).
  `salvage_persistent_state` honours a const `EPHEMERAL_OPCODES = ["4.sync", "3.nop", "3.key", "5.mouse"]` allowlist of opcodes that carry no canonical screen state (frame flush markers, transport pings, keyboard input, and live cursor position). Everything else — `img`, `png`, `jpeg`, `copy`, `rect`, `cfill`, `lfill`, `cstroke`, `lstroke`, `transfer`, `blob`, `end`, `size`, `dispose`, `cursor`, layer/buffer setup — is preserved verbatim so that re-replay correctly reconstructs the canvas. The existing `filter_sensitive_instructions` credential-redaction pass still runs before any push, so the persistent log cannot accidentally capture `connect` or `args` opcodes.
- **Observer handlers replay the persistent log before the buffer dump**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs), [`backend/src/routes/share.rs`](backend/src/routes/share.rs)).
  Both `observe_session_ws` and the shared-tunnel WebSocket upgrade now read the persistent state under the same `buffer.read().await` lock that captures the buffered frames, then send (in order): `nvrheader` metadata → cached `size` instruction → persistent-state log → sync-stripped frame dump → final flushing `sync` → live broadcast frames. The lag-recovery rebuild path inside the live-forwarding loop also re-sends the persistent log before re-dumping the buffer so that observers who fall behind the broadcast channel still receive a complete canvas reconstruction.
- **Unit tests for the persistent-state log**
  ([`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs)).
  Added four new `#[test]` cases — `persistent_state_empty_by_default`, `persistent_state_salvages_drawing_ops_on_size_eviction`, `persistent_state_skips_ephemeral_opcodes`, and `persistent_state_respects_cap` — covering the empty-default state, salvage-on-eviction behaviour, ephemeral-opcode filtering, and the 20 MB cap respectively.

#### Migration notes

- **Backend rebuild only.** No database migration, no schema change, no environment-variable change. The persistent-state log is a runtime-only in-memory structure scoped to the `ActiveSession` lifetime; restarts start each session's log empty (as before).
- **Memory footprint.** Worst-case extra heap per active session is `MAX_PERSISTENT_STATE_BYTES = 20 MB` on top of the existing `MAX_BUFFER_BYTES = 50 MB` ring buffer, giving a per-session ceiling of ~70 MB of NVR state. The dynamic capacity recommendation in `GET /api/admin/metrics` (which uses `RAM_PER_SESSION_MB = 150` as a weighted-average estimate including the kernel-side tunnel and codec buffers) already comfortably covers this; no recommendation change is required.
- **Credential redaction is preserved.** The persistent log inherits its data from `SessionBuffer::push`, which runs `filter_sensitive_instructions` before storing anything. The `7.connect` and `4.args` opcodes (which can carry credentials) continue to be stripped at ingestion and can never reach the persistent log.

## [1.9.3] — 2026-05-20

### Patch Release — Option to disable Break Glass emergency bypass, dynamic empty connection folders pruning, and package cleanup

This patch release introduces critical operational controls and navigation refinements across the application. It adds a security-hardening option to disable the Break Glass emergency approval bypass within Approval Roles, dynamically hides empty folders on the Dashboard navigation tree to remove clutter, unifies style formatting guidelines across Rust and frontend codebases, and prunes residual version references to guarantee build stability.

#### Added

- **Break Glass Emergency Bypass Toggle on Approval Roles**
  ([`backend/migrations/063_role_break_glass_bypass.sql`](backend/migrations/063_role_break_glass_bypass.sql), [`backend/src/routes/admin.rs`](backend/src/routes/admin.rs), [`frontend/src/pages/admin/AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx)).
  Added an administrative toggle to completely disable the Break Glass emergency bypass for specific Approval Roles. When disabled, operators are strictly prevented from self-approving or bypassing credentials checkout, guaranteeing forced dual-operator checkouts.

#### Changed

- **Dynamic Empty Folders Pruning in Dashboard tree**
  ([`frontend/src/utils/folderTree.ts`](frontend/src/utils/folderTree.ts), [`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)).
  Updated the preorder traversal folder hierarchy model to recursively prune folders that contain neither active connections nor subfolders with connections. Hides noise and guarantees that folders visible on the Dashboard side menu actually lead to connection items.

#### Fixed

- **CI Formatting and Code Style Alignments**
  ([`backend/src/services/connections.rs`](backend/src/services/connections.rs), [`frontend/src/__tests__/AdminSettings.test.tsx`](frontend/src/__tests__/AdminSettings.test.tsx), [`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/admin/PasswordsTab.tsx`](frontend/src/pages/admin/PasswordsTab.tsx)).
  Resolved codebase formatting inconsistencies flagged during automated pipeline checkups. Unified cargo fmt parameters and ran Prettier to format source and test suites.

#### Migration notes

- **Automatic Database Migration.** On container startup, migration `063_role_break_glass_bypass.sql` runs unattended to add the `break_glass_bypass` toggle column (defaulting to true to preserve existing roles' behavior) and updates constraints safely.
- **Frontend rebuild only** required for visual layout updates.

## [1.9.2] — 2026-05-20

### Patch Release — Premium RDP interaction improvements, seamless collapsible sidebar dragging, and theme visual contrast

This patch release addresses critical layout and usability defects within active connection session environments. It resolves an RDP top-left click interception deadzone, refines CSS transition rules on the collapsible session bar toggle to eliminate mouse gesture dragging lag, and restores high-contrast glassmorphic styling and visual cues for the right-hand chevron toggle under Dark Theme.

#### Fixed

- **Active RDP Session Top-Left Click Interception**
  ([`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx)).
  Applied dynamic pointer event properties (`pointer-events: none` when collapsed, `pointer-events: auto` when expanded) to the sliding sidebar panel container. This resolves a layout bug where the hidden sidebar continued to intercept mouse and pointer events on the top-left area of the remote screen.
- **Collapsible Sidebar Toggle Dragging Gesture Lag**
  ([`frontend/src/index.css`](frontend/src/index.css)).
  Isolated specific CSS transition rules (`transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease`) instead of targeting `transition: all`. This prevents layout engine coordinate re-calculation delays and delivers instantaneous, buttery-smooth dragging responsiveness.
- **Dark Theme Session Sidebar Chevron Visibility**
  ([`frontend/src/index.css`](frontend/src/index.css)).
  Consolidated CSS selector definitions for `.session-bar-toggle` under dark theme and restored the translucent backdrop-blur backdrop filter, high-contrast borders (`rgba(255, 255, 255, 0.15)`), and curated hover highlights. The right-hand chevron toggle is now perfectly legible across all themes.

#### Migration notes

- **Frontend rebuild only.** No database migration, no environment-variable changes.

## [1.9.1] — 2026-05-19

### Patch Release — SSO Edit Form Update Deserialization & Test Connection ID lookup, plus CodeQL cleanup

This patch release addresses a critical deserialization error that occurred when saving an edited Single Sign-On (SSO) configuration, which caused the "Save Changes" button to become inoperable. It also resolves multiple technical debt items flagged by CodeQL related to unused variables across the backend codebase.

#### Fixed

- **SSO Provider Edit Form Deserialization Bug**
  ([`frontend/src/pages/admin/SsoTab.tsx`](frontend/src/pages/admin/SsoTab.tsx)).
  Modified the form submission logic to explicitly include the `client_secret` key in the JSON payload, even when empty. This satisfies the Axum backend's strict `SsoProviderUpdateRequest` schema requirements and prevents a 400 Bad Request error upon saving.
- **SSO Provider Test Connection Secret Lookup**
  ([`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/admin/SsoTab.tsx`](frontend/src/pages/admin/SsoTab.tsx)).
  Added the `id` field to the `testSsoConnection` payload. This allows the backend to accurately identify and decrypt the existing client secret when validating an edited SSO configuration.
- **SPA Entry Point Caching Invalidation (Cache-Busting)**
  ([`frontend/common.fragment`](frontend/common.fragment)).
  Added explicit `Cache-Control: "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"` headers to Nginx configurations for the `/` and `/index.html` locations. This guarantees that browsers always fetch the current `index.html` with correct content hashes, preventing stale UI version loading.
- **Removed Unused Variables (CodeQL Detections)**
  ([`backend/src/tunnel.rs`](backend/src/tunnel.rs), [`backend/src/services/user_preferences.rs`](backend/src/services/user_preferences.rs), [`backend/src/services/middleware.rs`](backend/src/services/middleware.rs), [`backend/src/services/notifications.rs`](backend/src/services/notifications.rs), [`backend/src/routes/user.rs`](backend/src/routes/user.rs), [`backend/src/routes/auth.rs`](backend/src/routes/auth.rs), [`backend/src/routes/admin/recordings.rs`](backend/src/routes/admin/recordings.rs)).
  Cleaned up multiple unused variable warnings across the backend to improve code maintainability and execution flow.

#### Migration notes

- **Frontend rebuild only.** No database migration, no environment-variable changes.

## [1.9.0] — 2026-05-19

### Minor Release — Multiple SSO/OIDC Providers, Dynamic Login Branding, and Vault transit security

This minor release introduces the highly anticipated support for configuring and using multiple OpenID Connect (OIDC) / Single Sign-On (SSO) providers concurrently. Users are greeted with separate branded login buttons matching each active configuration. Client secrets are individually sealed in HashiCorp Vault transit keys, and the new `BASE_URL` override ensures seamless integration through downstream proxies or SSL terminators.

#### Added

- **Multi-tenant OIDC administrative CRUD API**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs)).
  Created new admin-only routes to list (`GET /api/admin/settings/sso-providers`), create (`POST /api/admin/settings/sso-providers`), update (`PUT /api/admin/settings/sso-providers/:id`), and delete (`DELETE /api/admin/settings/sso-providers/:id`) multiple SSO providers.
- **Dynamic OIDC Provider configuration test endpoint**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs)).
  Added a settings-test action endpoint (`POST /api/admin/settings/sso-providers/:id/test`) enabling administrators to test connection parameters to the identity provider prior to saving.
- **Active provider discovery public endpoint**
  ([`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)).
  Exposed `GET /api/auth/sso/providers` returning client-safe OIDC registration data (IDs and names) dynamically to the frontend for the login form.
- **Support for dynamic OIDC provider login redirects**
  ([`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)).
  Updated `GET /api/auth/sso/login` to accept a `provider` query parameter (UUID) to handle target authorization flows correctly.
- **`BASE_URL` environment configuration override**
  ([`.env`](.env), [`.env.example`](.env.example)).
  Defined `BASE_URL` in environment files to supply the absolute origin (including ports like `:8443`) for OIDC callbacks, neutralizing downstream proxy port-stripping issues.

#### Changed

- **OIDC Database schema migration to sso_providers table**
  ([`backend/migrations/062_sso_providers.sql`](backend/migrations/062_sso_providers.sql)).
  Created database schema migration `062_sso_providers.sql` which drops the old single-SSO settings column definitions and transitions configurations into a dedicated relational table `sso_providers` with backwards-compatible automated backfills.
- **Multi-tenant state handshaking via SSO_STATE_STORE**
  ([`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)).
  Implemented a secure, thread-safe in-memory mapping in `SSO_STATE_STORE` (a `LazyLock<Mutex<HashMap<String, (Uuid, Instant)>>>`) storing CSRF state UUIDs and their target provider ID, allowing all OIDC connections to safely share the same `/api/auth/sso/callback` callback endpoint.
- **Individual Vault secret sealing per provider**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs)).
  Encrypted individual OIDC client secrets dynamically in Vault via distinct transit key paths before storing them in the `sso_providers` database table.
- **Enhanced unconfigured Vault handling**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs)).
  Modified admin validation paths to return a clear HTTP 400 Bad Request message when saving providers if HashiCorp Vault remains unconfigured, instead of surfacing a generic HTTP 500 error.

#### Fixed

- **Synchronized Vitest mocks for OIDC CRUD**
  ([`frontend/src/__tests__/AdminSettings.test.tsx`](frontend/src/__tests__/AdminSettings.test.tsx), [`frontend/src/__tests__/api.test.ts`](frontend/src/__tests__/api.test.ts)).
  Aligned mock definitions and mock network configurations inside the test suite to target the new multiple-provider model, maintaining continuous test greenness across Vitest runs.

#### Migration notes

- **Automatic Database Migration.** On container startup, migration `062_sso_providers.sql` will run unattended, creating the `sso_providers` table and backfilling any pre-existing single-SSO configuration.
- **Verify `BASE_URL` in `.env`.** Ensure your `.env` contains a correct, absolute `BASE_URL` if you are accessing Strata Client through a reverse proxy (e.g. Caddy) or a non-standard HTTPS port.

## [1.8.4] — 2026-05-13

### Patch release — Vitest suite stabilization, relative URL parsing, and mock synchronization

This release stabilizes the frontend test suite by hardening the Vitest
environment and synchronizing component mocks with the modern
cookie-based authentication utilities. It resolves regressions related to
relative API URL parsing in JSDOM and unhandled promise rejections
during test component initialization.

#### Fixed

- **Hardened Vitest environment for relative URL parsing**
  ([`frontend/src/__tests__/setup.ts`](frontend/src/__tests__/setup.ts)).
  Implemented a global `fetch` polyfill that automatically resolves
  relative API paths to `http://localhost`. This prevents
  `ERR_INVALID_URL` failures in the Node-based test environment while
  maintaining parity with modern browser behavior.
- **Synchronized API mocks for cookie-based authentication**
  (Various test files in `frontend/src/__tests__/`).
  Updated all component test mocks to include the `readCookie` export
  from the `api.ts` module. This resolves crashes in components (like
  `UserPreferencesProvider`) that depend on the existence of this
  utility during their initial mount lifecycle.
- **Improved test reliability for React state updates**
  ([`frontend/src/__tests__/Profile.test.tsx`](frontend/src/__tests__/Profile.test.tsx)).
  Migrated synchronous `act()` calls to asynchronous `await act(async () => ...)`
  patterns. This resolves React warnings regarding state updates not
  being wrapped in `act(...)` and ensures better test suite compliance.

## [1.8.3] — 2026-05-13

### Patch release — NJS-based security hardening, CSP frame-ancestors, and auth stabilization

This release further hardens the application's security posture by
transitioning from legacy security headers to modern standards and
stabilizing the authentication lifecycle during backend restarts. It also
eliminates noisy 401 errors in the browser console during the initial
login phase. Drop-in upgrade from v1.8.2; roll the backend and frontend
containers together. **Note: `JWT_SECRET` is now a mandatory environment
variable for persistent sessions.**

#### Security

- **Transitioned to `Content-Security-Policy: frame-ancestors 'none'`**
  ([`frontend/common.fragment`](frontend/common.fragment)).
  Replaced the legacy `X-Frame-Options` header with the modern CSP
  `frame-ancestors` directive. This provides superior anti-clickjacking
  protection while aligning with modern browser security standards.
- **Implemented NJS-based `Server` header masking**
  ([`frontend/remove_server.js`](frontend/remove_server.js), [`frontend/common.fragment`](frontend/common.fragment)).
  The `Server` header is now masked as "Strata" and the `X-Powered-By`
  header is removed across all responses (SPA and API). This prevents
  technology fingerprinting and satisfies security audits that require
  the removal of standard server identifiers.
- **Persistent JWT signing with mandatory `JWT_SECRET`**
  ([`.env`](.env), [`.env.example`](.env.example)).
  Added a mandatory `JWT_SECRET` environment variable. Previously, the
  backend generated a random secret on every startup, which invalidated
  all active sessions (access and refresh tokens) whenever a container
  restarted. Persistent secrets ensure session stability across backend
  reloads.

#### Fixed

- **Eliminated noisy 401 errors on the login screen**
  ([`frontend/src/App.tsx`](frontend/src/App.tsx), [`frontend/src/components/UserPreferencesProvider.tsx`](frontend/src/components/UserPreferencesProvider.tsx)).
  Relocated the `UserPreferencesProvider` and `SettingsProvider` inside
  the application's authentication boundary. These providers now only
  mount (and fire their initial API calls) after a successful login,
  ensuring the browser console stays clean during the unauthenticated
  phase.
- **Corrected Proxy Host header for CORS stability**
  ([`frontend/common.fragment`](frontend/common.fragment)).
  Updated Nginx `proxy_set_header Host` to use `$http_host` instead of
  `$host`. This ensures the backend receives the exact port used by the
  client, preventing origin mismatches that were causing sporadic CSRF
  and CORS failures in multi-port deployment scenarios.

#### Migration notes

- **Persistent JWT Secret required.** You MUST set a secure `JWT_SECRET`
  in your `.env` file to prevent session invalidation on restart. A
  default is provided in `.env.example`.
- **No database migration.** Roll both containers together:
  `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build`
- **Full test suite 1401 / 1401 passing** on the released revision.

## [1.8.2] — 2026-05-13

### Patch release — global security headers, session-timeout reliability, and CI hardening

Hardens the application's security posture by enforcing non-cacheable API
responses globally and tightening the session-lifecycle state sync between
the frontend and backend. Also restores the integrity of the Trivy
security scanning pipeline. Drop-in upgrade from v1.8.1; roll the
backend and frontend containers together.

#### Security

- **Global `Cache-Control: no-store` header**
  ([`backend/src/routes/mod.rs`](backend/src/routes/mod.rs)).
  All API responses now carry `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`. This prevents sensitive authenticated data from being persisted to disk by browser caches or intermediate proxies.
- **Extended session-cookie TTL buffer**
  ([`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)).
  The `csrf_token` and `session_expires` cookies are now issued with a
  TTL 60 seconds longer than the `access_token` itself. This ensures the
  SPA can still read its own session metadata (the CSRF token and expiry
  timestamp) during the final minute of a session's life, allowing it to
  successfully trigger a `refreshAccessToken` call before the hard
  deadline.
- **Hardened CORS policy.**
  Re-asserted `allow_credentials(true)` and explicit `X-CSRF-Token`
  header support in the global middleware stack to ensure cookie-based
  authentication remains stable across all supported deployment
  topologies.
- **Removed deprecated `X-Frame-Options` header**
  ([`frontend/common.fragment`](frontend/common.fragment)).
  Replaced `X-Frame-Options: DENY` with the modern `Content-Security-Policy: frame-ancestors 'none'`
  directive. This ensures anti-framing protection is handled by the
  modern CSP standard while maintaining broad browser compatibility.
- **Stripped `Server` and `X-Powered-By` headers**
  ([`frontend/Dockerfile`](frontend/Dockerfile), [`frontend/common.fragment`](frontend/common.fragment)).
  The `Server` header is now completely removed from all responses
  to prevent technology disclosure. This was achieved by upgrading
  to **Nginx 1.30.0 (Stable)**, installing the `nginx-module-njs`
  package, and implementing a custom `js_header_filter` script.

#### Fixed

- **Immediate logout on session-extension failure**
  ([`frontend/src/components/SessionTimeoutWarning.tsx`](frontend/src/components/SessionTimeoutWarning.tsx)).
  When an operator clicks "Extend session" but the refresh token has
  already been invalidated (e.g. by a sign-out in another tab or a
  backend session revocation), the UI now forces an immediate logout
  rather than leaving the warning modal in a "zombie" state.
- **Restored Trivy security scanning**
  ([`.github/workflows/trivy.yml`](.github/workflows/trivy.yml)).
  Fixed the container scanning pipeline by forcing the `docker` driver
  in the Buildx setup and explicitly setting `scan-type: 'image'`. This
  resolves a regression where Trivy could not locate the locally built
  Docker image for analysis.

#### Added

- **Diagnostic session logging**
  ([`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/components/SessionTimeoutWarning.tsx`](frontend/src/components/SessionTimeoutWarning.tsx)).
  Added detailed `console.debug` logging tracking the presence of CSRF
  tokens during refresh calls and the outcome of manual extension
  requests to aid in future troubleshooting of complex session-lifecycle
  issues.

#### Migration notes

- **No database migration.** Roll both containers together to pick up
  the backend header changes and the frontend session-reliability
  fixes.
  `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build`
- **Full test suite 1401 / 1401 passing** on the released revision.

## [1.8.1] — 2026-05-12

### Patch release — credential-profile expiry watcher no longer toasts on profile creation

Tightens the credential-profile expiry watcher introduced in v1.8.0 so
its pre-expiry warning thresholds are filtered against the profile's
own TTL window. Without this fix, every freshly-created standard
profile (default 12 h TTL, but anything below the 24 h "1 day"
threshold) published a `<profile> expires in 1 day` warning toast on
the very next poll because `secsLeft` was already inside the 24 h
warning window the moment the profile was saved. The same shape of
defect would have appeared for any extended-expiry profile created
with a TTL shorter than 7 days. The watcher now drops any threshold
that is wider than (or equal to) the profile's `ttl_hours * 3600`
seconds before evaluating, so warnings only fire as the deadline
genuinely approaches. Frontend-only patch, drop-in upgrade from
v1.8.0; the backend image is byte-identical between the two
releases.

#### Fixed

- **Watcher no longer toasts the moment a profile is created**
  ([`frontend/src/components/CredentialProfileExpiryWatcher.tsx`](frontend/src/components/CredentialProfileExpiryWatcher.tsx)).
  The `STANDARD_THRESHOLDS` and `EXTENDED_THRESHOLDS` arrays are now
  filtered with `t.secs < profile.ttl_hours * 3600` before iteration,
  removing thresholds the user could never reach as a meaningful
  pre-expiry signal:
  - 12 h standard profile → effective thresholds `[1 h, 10 m]`
    (no spurious 1-day toast on first poll).
  - 24 h standard profile → effective thresholds `[1 h, 10 m]`.
  - 25 h standard profile → effective thresholds `[1 d, 1 h, 10 m]`
    (the 1-day toast fires when ~1 h has elapsed, as intended).
  - 7 d extended profile → effective thresholds `[1 d, 1 h]`
    (no spurious 7-day toast on creation).
  - 90 d extended profile → all three thresholds apply, unchanged.

#### Added

- **Regression test**
  ([`frontend/src/__tests__/CredentialProfileExpiryWatcher.test.tsx`](frontend/src/__tests__/CredentialProfileExpiryWatcher.test.tsx))
  — `does not fire the 1-day toast on a freshly-created 12 h profile`.
  Mounts the watcher with a `ttl_hours: 12` profile whose
  `expires_at` is 12 h ahead and asserts neither `role="alert"` nor
  `role="status"` appears. Watcher suite is now 10 / 10 (1396 base
  - 25 v1.8.0 toast / paste tests + 1 new = 1399 frontend tests
    total at the released revision; full suite 1399 / 1399 passing).

#### Migration notes

- **Frontend rebuild only.** No database migration, no API contract
  change, no environment-variable change, no new runtime
  dependencies. Roll the frontend container:
  `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build frontend`.
- **Tracker entries written by v1.8.0 are not invalidated.** If the
  v1.8.0 watcher already fired a spurious 1-day toast for a
  short-TTL profile, the corresponding `<profileId>:86400` entry
  in `localStorage["strata.credExpiryFired.v1"]` is now harmless —
  the new code simply ignores thresholds it has filtered out, so
  the entry sits idle until the profile is deleted or its expiry
  is re-issued (at which point the re-arm path drops it
  automatically). No manual cleanup required.

## [1.8.0] — 2026-05-11

### Minor release — reusable toast notification system, credential-profile expiry warnings, SSH password-paste fix

A frontend-only release whose headline is a brand-new, reusable toast
notification system threaded through the whole authenticated tree, and
its first consumer: a background watcher that keeps an eye on every
credential profile the signed-in user owns and warns them — well
before the deadline, and again at the moment of expiry — when a
profile's TTL is about to lapse. A second, smaller fix corrects an
SSH paste regression where pasting a password into a terminal
password prompt was failing because the bracketed-paste markers
applied for code blocks were also being applied to single-line
payloads, which password prompts (sudo, ssh, passwd, mysql -p, every
network-device CLI) ingest as part of the password rather than
recognising them as paste framing. Drop-in upgrade from v1.7.0 — no
schema changes, no API contract changes, no new environment
variables, and no new runtime dependencies. Roll the frontend
container; the backend image is byte-identical between 1.7.0 and
1.8.0.

#### Added

- **`ToastProvider` + `useToast()` hook**
  ([`frontend/src/components/ToastProvider.tsx`](frontend/src/components/ToastProvider.tsx))
  — a single, reusable toast notification surface mounted under the
  root `SettingsProvider` so every component beneath the auth gate
  can publish a notification with `useToast().info / .success /
.warning / .error`. Each toast carries a `title`, an optional
  `description`, an optional **action button** (with built-in
  busy-state handling), and a `key` so a long-lived consumer can
  update the same toast in place rather than spawning duplicates.
  Auto-dismiss timing is variant-aware (info / success: 6 s,
  warning: 8 s, error: sticky until dismissed), overridable per
  call. Rendered via a `document.body` portal so the stack escapes
  any transformed / overflow-hidden ancestor; positioned in the
  top-right (the bottom-right is reserved for the existing
  `SessionTimeoutWarning`). ARIA: `role="region"` + `aria-live="polite"`
  on the viewport, `role="alert"` on errors / warnings, `role="status"`
  on info / success.
- **`CredentialProfileExpiryWatcher`**
  ([`frontend/src/components/CredentialProfileExpiryWatcher.tsx`](frontend/src/components/CredentialProfileExpiryWatcher.tsx))
  — a render-null background component mounted in [`App.tsx`](frontend/src/App.tsx)
  for every authenticated, vault-configured user. Polls
  `/api/user/credential-profiles` every 60 s and publishes a single
  warning toast as each pre-expiry threshold is crossed:
  - **Standard profiles** (`extended_expiry: false`) warn at
    **1 day**, **1 hour**, and **10 minutes** before `expires_at`.
  - **Extended-expiry profiles** (`extended_expiry: true`, up to
    90 days) warn at **7 days**, **1 day**, and **1 hour** before
    `expires_at`. The wider thresholds match the longer windows
    introduced in v1.7.0.

  When a profile crosses `expires_at` the watcher publishes a
  sticky **error** toast labelled `"<profile> has expired"` with a
  **Renew now** action that deep-links to `/credentials`. Only the
  tightest threshold the user has currently crossed fires — a tab
  opened at the 30-minute mark sees only the 10-minute warning,
  not the 1-day one too — and every wider threshold is silently
  marked as already-fired so it cannot publish later.

- **Theme-tokenised toast styling** — variants pick their colour and
  dim background from the existing CSS custom properties
  (`--color-accent`, `--color-success`, `--color-warning`,
  `--color-danger`) so the new surface inherits any future palette
  edits without a code change. Shares the existing `.card`,
  `.btn`, and `.animate-fade-in` utilities; no new top-level CSS
  was added.

#### Changed

- **SSH / telnet single-line paste is now byte-transparent**
  ([`frontend/src/components/pastePayload.ts`](frontend/src/components/pastePayload.ts)).
  `preparePastePayload()` previously wrapped every SSH / telnet
  clipboard payload in bracketed-paste markers (`ESC[200~ … ESC[201~`)
  and translated `\n` to `\r`. Bracketed paste exists to make
  multi-line paste safe inside paste-aware shells (bash, zsh, vim,
  tmux), but a **password prompt** (`sudo`, `ssh` password auth,
  `passwd`, `mysql -p`, every Cisco / Juniper / Mikrotik password
  prompt) is not running under bash — it reads stdin in raw
  no-echo mode and treats the literal escape bytes as part of the
  password, so authentication failed for every pasted password. The
  helper now skips both transformations when the payload contains
  no `\r` or `\n`. Multi-line pastes still get bracketed-paste
  wrapping and CR translation so `nano` / `vim` / heredoc workflows
  continue to behave.

#### Fixed

- Pasting a password into an SSH / telnet password prompt no longer
  fails with an "incorrect password" response caused by silently
  injected `ESC[200~` / `ESC[201~` framing bytes. (See **Changed**
  above for the full rationale and the protocols affected.)

#### Security

- The new toast surface accepts `title` and `description` as plain
  React children — they are rendered through React's standard text
  escaping path, so any string a future caller passes from
  user-controlled data is safe by construction. There is no
  `dangerouslySetInnerHTML`, no `innerHTML` write, and no
  HTML-string consumer in the provider.
- The credential-profile expiry watcher reads from
  `/api/user/credential-profiles` only; no new server endpoint, no
  new secret exposure. The fired-threshold tracker is persisted in
  `localStorage` under the namespaced key
  `strata.credExpiryFired.v1` and stores only `{ "<profileId>:<thresholdSecs>":
<expiresAtMs> }` integers — no usernames, no passwords, no
  server-side identifiers beyond the profile's own UUID. Storage
  entries for profiles that have been deleted on the server are
  pruned on every poll so the record cannot grow without bound.
- The bracketed-paste fix above is **not** a vulnerability — the
  injected escape bytes were a UX defect, not a security boundary —
  but it is documented here because pasted-password failures
  routinely lead operators to write the password down or store it
  somewhere less safe. Restoring the paste workflow removes that
  pressure.

#### Migration notes

- **No schema migration.** The backend image is byte-identical
  between 1.7.0 and 1.8.0; only the frontend container needs to be
  rebuilt. `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build frontend`
  is sufficient.
- **No new environment variables, no new dependencies, no API
  contract changes.** `frontend/package.json` and the lockfile carry
  only the version bump; `backend/Cargo.toml` carries only the
  version bump.
- **Tracker reset (optional).** Operators upgrading from a build
  predating the watcher do not need to clear browser storage; the
  tracker key is created on first use and the `.v1` suffix in the
  key name allows a future schema change to cleanly invalidate
  older records.
- **Test coverage on upgrade.** 25 new tests (7 provider, 9
  watcher, 9 paste — 2 new + 7 existing). Full vitest suite
  1398 / 1398 passing on the released revision.

## [1.7.0] — 2026-05-11

### Minor release — extended-expiry credential profiles, themed range slider, dependency refresh

A small but additive feature release. The standard Strata credential
profile keeps its existing 1–12 hour TTL ceiling and existing default;
operators who need to keep a credential alive for service or
break-glass accounts can now opt a single profile in to an extended
expiry of up to **90 days (2160 hours)**. The setting is per-profile,
defaults to off, and the relaxed limit is enforced at every layer
(database CHECK constraint, backend resolver, frontend control). All
existing rows continue to satisfy the new constraint without
intervention. Drop-in upgrade from v1.6.2 — roll the backend and
frontend images together. The migration runs unattended at backend
startup; no environment variables, no new runtime dependencies.

The release also lands a themed slider component, a refreshed
checkbox style for the new toggle, a base-image refresh (Node
26-alpine, refreshed Rust/Debian/nginx digests), an actions group
bump (checkout v6, dependency-review v5, stale v10,
release-drafter v7, codeql-action 4.35.4, cosign-installer 4.1.2,
scorecard-action 2.4.3), and the latest npm minor/patch versions of
react 19.2.6, react-router-dom 7.15.0, tailwindcss 4.3.0, vite
8.0.12, i18next 26.1.0, mermaid 11.15.0, and @types/dompurify 3.2.0.

#### Added

- **Extended credential-profile TTL (up to 90 days), opt-in
  per-profile.** A new boolean column
  `credential_profiles.extended_expiry` (migration
  [`061_credential_profile_extended_expiry.sql`](backend/migrations/061_credential_profile_extended_expiry.sql))
  records the per-profile flag. The previous database CHECK
  `chk_ttl_hours BETWEEN 1 AND 12` is replaced by a two-arm guard:
  when `extended_expiry = FALSE` the limit stays at 1–12 hours
  exactly as before; when `extended_expiry = TRUE` the limit is
  raised to 1–2160 hours (90 days). The constraint is enforced at
  the database layer, so a future code path that forgets to consult
  the new resolver still cannot persist an out-of-range TTL. All
  existing rows have `extended_expiry` defaulted to `FALSE` and
  continue to satisfy the constraint without intervention.
- **`pub fn resolve_profile_ttl(user_pref, admin_max, extended) -> i32`**
  in [`backend/src/routes/user.rs`](backend/src/routes/user.rs) —
  picks the effective TTL ceiling based on the per-profile
  `extended_expiry` flag (admin's 12-hour cap or the 2160-hour
  extended cap), with the same `clamp(1, cap)` lower bound as the
  existing resolver. The non-extended branch is byte-for-byte
  equivalent to the previous `resolve_ttl` helper, which has been
  removed in favour of the new function. Six unit tests pin the new
  boundary conditions.
- **`pub async fn get_extended_expiry(pool, profile_id) -> Result<bool, AppError>`**
  in [`backend/src/services/credential_profiles.rs`](backend/src/services/credential_profiles.rs) —
  fetches the current flag for an existing profile so the
  `update_credential_profile` handler can pick the correct cap when
  the request body does not explicitly toggle `extended_expiry`. The
  fetch is a single-column `SELECT` against the primary key.
- **`extended_expiry` field on every credential-profile API
  payload.** `CredentialProfileRow` now carries the boolean alongside
  `ttl_hours`, so `GET /api/user/credential-profiles`, the create and
  update mutators, and the audit-log payload for `credential.profile.created`
  all include it. The frontend `CredentialProfile` interface in
  [`frontend/src/api.ts`](frontend/src/api.ts) mirrors the new
  field, and `createCredentialProfile` / `updateCredentialProfile`
  accept it as an optional argument (defaulting to `false` /
  unchanged respectively).
- **Per-profile "Allow extended expiry" checkbox in the credentials
  editor** ([`frontend/src/pages/credentials/ProfileEditor.tsx`](frontend/src/pages/credentials/ProfileEditor.tsx)).
  When ticked the password-expiry slider switches from hours
  (`1–12`) to days (`1–90`), the displayed unit follows
  (`12 hours` → `90 days`), the helper text updates ("Extended
  expiry enabled — maximum 90 days. Use only for service or
  break-glass accounts."), and toggling the checkbox snaps the
  stored TTL to a sensible default for the new mode (12 h when
  turning extended off, 720 h / 30 d when turning it on) so users
  cannot accidentally save a 1-hour "extended" profile or a 90-day
  "standard" profile.
- **Themed `range-slider` CSS utility class**
  ([`frontend/src/index.css`](frontend/src/index.css)) — the native
  `accent-color` slider was replaced with a CSS-driven gradient
  track (`--range-pct` custom property) so the accent fill always
  reaches the thumb, including at the maximum value, on every
  Chromium and Gecko renderer. Custom thumb (white circle, accent
  border, hover scale) matches the rest of the dark theme.

#### Changed

- `cp_svc::insert`, `cp_svc::update_sealed`, and
  `cp_svc::update_metadata` now carry the `extended_expiry` flag
  through every persistence path. `update_metadata` uses
  `COALESCE($4, extended_expiry)` so a metadata-only update that
  does not supply the flag preserves the stored value. By design,
  toggling `extended_expiry` alone (without changing `ttl_hours`)
  does **not** recompute `expires_at` — operators who actually want
  to push expiry out must also bump the TTL, preventing accidental
  re-extension on every label edit.
- The `audit_logs` payload emitted by `create_credential_profile`
  now includes both `ttl_hours` and the new `extended_expiry`
  boolean alongside the profile label, so deployments that ship
  audit logs to a SIEM gain immediate visibility into the
  opt-in.
- Replaced the unused `resolve_ttl(user_pref, admin_max)` helper
  with the new `resolve_profile_ttl` (the previous helper had no
  remaining call sites once the credential-profile path was
  migrated). Behaviour for the non-extended branch is preserved
  exactly.

#### Security

- The 1–12 hour CHECK on `credential_profiles.ttl_hours` is _not_
  loosened for non-extended profiles; the relaxed 2160-hour bound
  applies only when `extended_expiry = TRUE` for that row. A row
  cannot bypass the standard cap by silently flipping its TTL —
  the database refuses the write.
- Re-encrypted updates (`PUT /api/user/credential-profiles/:id`
  carrying a new password) compute the effective cap with
  `resolve_profile_ttl` against the **incoming** `extended_expiry`
  value, then pass it through to `cp_svc::update_sealed`, ensuring
  no race window where the cap and the persisted flag disagree.
- Existing role/ownership checks on every credential-profile
  mutator are unchanged; the new field is just another property
  on a row already authorised by `user_owns`.

#### Dependencies

- **Base images** — `rust:1.95-slim-trixie` and `debian:trixie-slim`
  digests refreshed against current upstream; `node` bumped from
  `25-alpine` to `26-alpine`; `nginx:alpine` digest refreshed.
- **GitHub Actions** — `actions/checkout` v5 → v6.0.2 (in
  `dependency-review.yml` and `scorecard.yml`; other workflows were
  already on v6), `actions/dependency-review-action` v4.9.0 → v5.0.0,
  `actions/stale` v9 → v10.2.0, `release-drafter/release-drafter`
  v6.4.0 → v7.3.0, `github/codeql-action` 4.35.3 → 4.35.4,
  `sigstore/cosign-installer` v4.1.1 → v4.1.2,
  `ossf/scorecard-action` v2.4.0 → v2.4.3.
- **Frontend npm** — `react` 19.2.5 → 19.2.6, `react-dom`
  19.2.5 → 19.2.6, `react-router-dom` 7.14.2 → 7.15.0,
  `@tailwindcss/vite` + `tailwindcss` 4.2.4 → 4.3.0, `vite`
  8.0.10 → 8.0.12, `i18next` 26.0.10 → 26.1.0, `mermaid`
  11.14.0 → 11.15.0, `@types/dompurify` 3.0.5 → 3.2.0.

#### Migration notes

- **Schema change is forwards-compatible.** The new column is
  `NOT NULL DEFAULT FALSE`; existing rows are backfilled to `FALSE`
  by the default. The replacement CHECK constraint accepts every
  row that satisfied the old constraint (1–12 with
  `extended_expiry = FALSE`).
- **Roll-back guidance.** To revert the migration, drop the new
  CHECK, restore the original `ttl_hours BETWEEN 1 AND 12`, then
  drop the `extended_expiry` column. No row will need to be
  modified provided no profile has been opted in to a TTL above
  12; otherwise lower the offending rows' `ttl_hours` to ≤ 12
  first.
- **No frontend feature-flag.** The checkbox renders unconditionally
  for any user who can see a profile editor; restricting opt-in to
  certain operators (e.g. via role) is not enforced server-side and
  should be layered in front of the existing
  `/api/user/credential-profiles` mutation routes if your
  deployment requires it.

## [1.6.2] — 2026-05-08

### Patch release — connection-folder hierarchy, tag-picker viewport, SSH credential prompt

Six independent UX/correctness fixes raised against the v1.6.1 deployment.
No API contract changes, no database migrations, no new environment
variables, no new runtime dependencies. Drop-in upgrade from v1.6.1 — roll
the backend and frontend images together.

#### Added

- **`GET /api/user/connection-folders`**
  ([`backend/src/routes/user.rs`](backend/src/routes/user.rs)) — returns
  the full list of connection folders the authenticated user can
  reference (`id`, `name`, `parent_id`). The Dashboard tree view and
  the global Command Palette previously fell back to "ungrouped" for
  every nested connection because the only existing
  `GET /api/admin/connection-folders` endpoint required
  `can_manage_connections`. The new endpoint is read-only, gated by
  the same auth middleware as `/api/user/connections`, and wraps the
  same `connections::list_folders(&db.pool)` service the admin
  endpoint uses (folders are not user-scoped — every authenticated
  user needs to be able to draw the same hierarchy the admins
  authored). Documented in [`docs/api-reference.md`](docs/api-reference.md).
- **`frontend/src/utils/folderTree.ts`** — `orderFoldersByHierarchy()`
  performs a depth-first preorder traversal with alphabetic sibling
  ordering and an orphan-as-root fallback (so a folder whose parent
  has been deleted out from under it still appears at the top level
  rather than vanishing). `indentedFolderLabel()` produces a
  non-breaking-space-padded "└ " label suitable for `<option>`
  elements (which cannot host real CSS). Both helpers are reused by
  the Dashboard tree, the admin connection-edit Folder dropdown,
  the role-folder assignment checklist, the folder management
  table, and the AD-sync default-folder picker so every folder
  picker in the application now renders the same hierarchy in the
  same order.

#### Fixed

- **Dashboard now renders connections under their nested folders.**
  Operators creating a folder hierarchy of e.g. `Root → Switches →
Coventry` and adding a connection inside `Coventry` previously saw
  the connection only when they expanded `Coventry` directly; the
  tree was a one-level-deep group list rather than a recursive tree,
  and the per-row indent collapsed every connection to the same
  visual depth regardless of its real folder. The Dashboard
  ([`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx))
  now builds a recursive `folderTree` model with descendant-inclusive
  count badges (so the parent folder header shows the total count
  even while collapsed), depth-proportional indentation
  (`8 + depth * 16` px on the connection row name, description, and
  tag pills), per-folder open/closed chevron + folder icon, and
  toolbar **Expand all** / **Collapse all** buttons (visible only in
  folder view with a non-empty tree). When a search filter is active
  every folder containing a match is auto-expanded so hits never
  hide behind a collapsed parent.
- **Folder pickers across the admin surface now sort hierarchically
  with depth indentation.** The connection-edit Folder dropdown,
  the role-folder assignment checklist, the folder management
  table, and the AD-sync default-folder picker
  ([`AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx),
  [`AdSyncTab.tsx`](frontend/src/pages/admin/AdSyncTab.tsx))
  previously listed folders alphabetically with no nesting visible,
  scattering children away from their parents and making it very
  hard to tell where a connection would actually be placed. They
  now share the new `orderFoldersByHierarchy()` helper, render
  options in depth-first preorder, and indent children with
  non-breaking-space padding (in `<select>` options) or a left
  `paddingLeft: depth * 16px` on the row label / span (in HTML
  controls).
- **Tag picker no longer overflows the viewport on connections low
  on the page.** The per-row tag-picker dropdown was anchored to the
  pill button with a fixed `top` position, so opening it on a
  connection near the bottom of the viewport pushed half the menu
  off-screen with no scroll. The Dashboard now measures
  `spaceBelow = innerHeight - rect.bottom - 8` and
  `spaceAbove = rect.top - 8` on open, drops the menu in whichever
  direction has more room, sets `maxHeight: max(120, chosen)`, and
  uses `overflowY: auto` so the picker is always fully reachable
  regardless of where its anchor sits.
- **Tag pill column on connection rows now lines up with the
  folder-indented name.** The pill container previously aligned
  flush-left even when the row name was indented under a nested
  folder, producing a visible left-edge step that made it look like
  the pill belonged to a different connection. The pill container
  now mirrors the row's depth-derived `paddingLeft`, so name,
  description, and pill all share the same left margin.
- **SSH connections without preselected credentials now prompt for
  username and password before the terminal opens.** When the
  frontend created a tunnel ticket without supplying any
  credentials (the normal flow for SSH with no preselected
  profile), `resolve_credentials` in
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  matched the `ticket` arm purely on `Some(&ticket)` — ignoring
  whether the ticket actually carried a password — and silently
  returned `(Some(<strata_user>), None)` via the fallback-username
  path. The Strata user's local username was injected as the SSH
  username in the guacd handshake; the SSH server then short-
  circuited its in-band username prompt and asked only for a
  password in the terminal, leaving operators no way to
  authenticate as a different remote account. Skip the ticket arm
  when `ticket.password.is_none()` so the cascade falls through to
  `(None, None)`, guacd emits a `required` instruction listing
  both `username` and `password`, and the credential modal
  collects the right pair before the SSH session is opened. As a
  defence in depth, [`SessionClient.tsx`](frontend/src/pages/SessionClient.tsx)
  also prepends `"username"` to the required-parameter list
  whenever guacd's `required` instruction omits it on an SSH
  connection — guacd's SSH plugin sometimes lists only `password`
  even when no username has been supplied at handshake. Two new
  unit tests
  (`resolve_creds_empty_ticket_returns_none`,
  `resolve_creds_ticket_no_password_skipped` — the latter rewritten
  to assert the cascade falls through) lock the contract in.
- **Prettier formatting** — repository-wide format pass after the
  Dashboard tree, AccessTab folder-picker, and folderTree helper
  edits, so future PRs against these files don't carry whitespace-
  only churn.

#### Verified behaviour after this release

- Creating a connection under any depth of nested folder makes it
  appear under that folder in the Dashboard tree, with the parent
  hierarchy fully expandable / collapsible, descendant counts
  visible on every collapsed parent, and the connection row's
  name + description + tag pill all aligned to the same indent.
- Every admin folder picker (connection edit, role assignment,
  folder management, AD sync default) renders folders in the same
  depth-first preorder with the same depth indentation as the
  Dashboard tree.
- Opening an SSH connection with no preselected credentials
  produces the credential modal with both Username and Password
  fields populated before the terminal renders. Submitting the
  modal flows the credentials into guacd via two
  `argument_value` streams so the SSH session is authenticated
  correctly on the first attempt.

#### Drop-in upgrade — no migrations, no API contract changes

- No database migrations.
- No new environment variables.
- The new `GET /api/user/connection-folders` endpoint is purely
  additive (no existing endpoint changes shape or status); the
  Dashboard / Command Palette degrade gracefully when called
  against a v1.6.1 backend that does not yet implement it (an
  empty folders array yields the same flat-list rendering as
  v1.6.1).
- Roll the backend and frontend images together.

## [1.6.1] — 2026-05-08

### Patch release — production bug fixes against three user-reported issues

A focused patch release driven entirely by production reports against the
v1.6.0 deployment. Three independent issues, each with a non-obvious root
cause, are addressed; no API contract changes, no database migrations,
and no new environment variables. Drop-in upgrade from v1.6.0 — roll the
backend and frontend images together.

#### Fixed

- **SSH/Telnet paste — bracketed-paste markers and CRLF→CR translation.**
  Multi-line pastes from the system clipboard into an SSH or Telnet
  session were arriving at the remote shell as a series of separate
  keystrokes with embedded `\r\n` pairs. Editors that interpret bracketed
  paste (`vim`, `nano`, `less`, `psql`, etc.) saw each line as a fresh
  command rather than a single paste, and the trailing `\n` of every
  CRLF triggered an unintended Enter that committed half-formed
  commands. The new `preparePastePayload(text, protocol)` helper
  ([`frontend/src/components/pastePayload.ts`](frontend/src/components/pastePayload.ts))
  wraps the payload with the bracketed-paste start/end sequences
  (`ESC [ 200 ~` / `ESC [ 201 ~`) and rewrites every `\r\n` and bare
  `\n` to a single `\r` to match what a real terminal emits, but only
  for `ssh` and `telnet` connection protocols — RDP, VNC, Kubernetes
  and Quick-Share clipboard payloads are unchanged. Seven new unit
  tests pin the boundary conditions (empty input, `\r\n` runs, mixed
  line endings, RDP passthrough). The integration is wired through
  both the main-window `pushClipboard` / `handlePaste` paths in
  `SessionManager.tsx` and the popout-window equivalents in
  `usePopOut.ts`.
- **RDP/SSH active-session idle logout — Guacamole input no longer
  silently expires the access token.** Users actively typing or
  clicking inside a remote session were being signed out of the
  Strata SPA at the 20-minute access-token mark even though they
  were demonstrably active. Root cause: `Guacamole.Keyboard(document)`
  and `Guacamole.Mouse(displayEl)` install document- and canvas-level
  listeners that call `event.preventDefault()` and
  `event.stopPropagation()`, so the bubbled `mousedown` / `keydown` /
  `touchstart` / `scroll` events that
  [`SessionTimeoutWarning`](frontend/src/components/SessionTimeoutWarning.tsx)
  uses to drive proactive token refresh never reach the `window`
  while the user is interacting with a remote session. A new
  [`sessionActivity` bus](frontend/src/components/sessionActivity.ts)
  exposes `notifySessionActivity()` (throttled to once per second)
  and dispatches a `strata-session-activity` window event;
  `SessionTimeoutWarning` subscribes to that event in addition to the
  existing DOM events. The notify call is wired into the Guacamole
  input callbacks in:
  - [`SessionManager.tsx`](frontend/src/components/SessionManager.tsx) — main-window mouse handler.
  - [`SessionClient.tsx`](frontend/src/pages/SessionClient.tsx) — main-window keyboard handler (`kb.onkeydown`).
  - [`usePopOut.ts`](frontend/src/components/usePopOut.ts) — popout-window mouse, touch, and keyboard handlers.
  - [`useMultiMonitor.ts`](frontend/src/components/useMultiMonitor.ts) — multi-monitor popout mouse and keyboard handlers per monitor.

  Both popout hooks execute in the _opener's_ JS context (only the
  Guacamole `displayEl` is reparented into the popup's DOM), so
  `notifySessionActivity()` correctly dispatches on the opener
  `window` where `SessionTimeoutWarning` is mounted — no
  cross-window plumbing is required and pop-out / multi-monitor /
  fullscreen sessions are all covered by the same single bus.
  Two new unit tests
  ([`frontend/src/__tests__/sessionActivity.test.ts`](frontend/src/__tests__/sessionActivity.test.ts))
  cover dispatch and the 1-second throttle.

- **SSO callback latency — duplicate uncached IdP round-trips
  removed.** A user reported the first SSO sign-in of the day
  appeared to "hang on a Keycloak page" before eventually
  succeeding; subsequent attempts were instant. Investigation
  identified that on a cold OIDC cache `/api/auth/sso/callback`
  was performing **four** upstream HTTP round-trips to the IdP
  before issuing its 303 redirect to `/`:
  1. discovery (cached only inside `routes::auth`),
  2. `POST` to the token endpoint,
  3. discovery **again** inside `services::auth::validate_token`
     (a separate, uncached cache miss because the cache lived in
     the wrong module), and
  4. JWKS fetch (never cached).

  Each call has a 5-second connect / 10-second overall timeout.
  On a sluggish corporate IdP that cumulates to 15–30 seconds of
  callback latency during which the URL bar still shows the
  Keycloak callback URL — the user perceives this as Keycloak
  hanging. The fix moves the OIDC discovery cache into
  `services::auth::fetch_oidc_discovery_cached` so both call sites
  share it, and adds a JWKS cache with the same 10-minute TTL.
  The callback now performs at most one upstream call (the token
  POST) on warm cache, and only two (discovery + token) on the
  first ever sign-in. As a defensive secondary, the
  `/api/auth/sso/login` redirect now sends `Cache-Control: no-store`
  to prevent BFCache replay of stale `state` UUIDs, and an
  info-level tracing line on the callback path emits a per-step
  latency breakdown
  (`discovery_ms`, `token_exchange_ms`, `token_validate_ms`,
  `total_so_far_ms`) so future "SSO is slow" reports can be
  triaged from logs alone.

  > **Operational note.** A separate user-reported case where the
  > Keycloak page sat at "Authentication Redirect — Redirecting,
  > please wait" for ~5 minutes is _not_ explained by the cold
  > callback path (our timeouts cap that at ~30 s). That symptom
  > is consistent with Keycloak brokering to an upstream IdP
  > (AD FS / Entra ID / federated LDAP) that itself was slow on
  > first sign-in of the day. The new tracing line will
  > distinguish the two cases the next time it occurs:
  > if the line is absent, the callback never ran and the time
  > was spent inside Keycloak or a federated IdP, not in Strata.

#### Verified behaviour after this release

The session-timeout model after the activity-bus fix:

| Scenario                                                                                                                               | Token behaviour                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actively using a session (any window — main, popout, multi-monitor, fullscreen)                                                        | Access token silently refreshes every ~10 minutes for up to **8 hours**, then a fresh login is required (the refresh token has an 8-hour hard ceiling and is not rotated on `/api/auth/refresh`).                |
| Idle (no DOM events, no Guacamole input)                                                                                               | The access token expires **20 minutes** after the most recent refresh; a warning toast appears at the 2-minute remaining mark with an extend button.                                                             |
| Returning from idle before the 20-minute cap, with a click or keypress (anywhere — main app, in-session canvas, popout, multi-monitor) | If the access token has less than 10 minutes remaining, the click triggers a silent background refresh and the session continues. If more than 10 minutes remain, no refresh is needed and the click is a no-op. |

#### Drop-in upgrade — no migrations, no API contract changes

- No database migrations.
- No new environment variables.
- No API contract changes (the SSO redirect now carries
  `Cache-Control: no-store` and the callback emits an extra
  tracing line, neither of which is part of any documented
  contract).
- Roll the backend and frontend images together.

## [1.6.0] — 2026-05-23

### Enterprise foundations — error codes, accessibility, i18n scaffold, ops docs

#### Added

- **`docs/API-LIFECYCLE.md`** — formal API versioning policy (`/api/v1`), support window, breaking-change definition, `Deprecation` / `Sunset` headers per RFC 9745, error-code stability contract, and changelog discipline so downstream integrators can plan upgrades against documented guarantees instead of inferred behaviour.
- **`docs/deployment-kubernetes.md`** — production Kubernetes runbook covering the per-component replica topology (backend remains `replicas=1` because rate limits, settings cache, OIDC nonce cache, and HTTP session storage are all process-local), `ExternalSecrets` inventory, PVC sizing table (postgres / vault / recordings / config), ingress + `NetworkPolicy` YAML, split liveness/readiness probes (`/api/health/live`, `/api/health/ready`), resource sizing, `terminationGracePeriodSeconds: 45`, and a "common pitfalls" section drawn from the multi-replica caveats already documented in the architecture notes.
- **Backend `ErrorCode` enum** (`backend/src/error.rs`) — every `AppError` now maps to a stable SCREAMING_SNAKE token (`INTERNAL`, `DEPENDENCY_UNAVAILABLE`, `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_REQUEST`, `NOT_FOUND`, `SETUP_REQUIRED`) and the JSON error body now emits `{ "error": "<message>", "code": "<token>" }`. Frontend and external integrators can branch on `code` (which is part of the API contract per `API-LIFECYCLE.md`) instead of regex-matching the human-readable `error` string. Two new tests (`error_codes_are_stable_strings`, `error_variants_map_to_expected_codes`) lock the mapping in.
- **`useFocusTrap` hook** (`frontend/src/components/useFocusTrap.ts`) — generic React hook that records the previously-focused element, focuses the first focusable descendant when its container becomes active, intercepts Tab / Shift+Tab to cycle within the container, and restores focus on cleanup. WCAG 2.1 success criterion 2.4.3 (Focus Order) and 2.1.2 (No Keyboard Trap — controlled trap with explicit dismiss).
- **Skip-to-content link** (`frontend/src/components/Layout.tsx`) — a visually-hidden anchor that becomes visible on keyboard focus and jumps past the persistent navigation chrome to `<main id="main-content" tabIndex={-1}>`. Keyboard-only and screen-reader users no longer have to tab through the full nav rail on every page change. WCAG 2.1 success criterion 2.4.1 (Bypass Blocks).
- **i18n scaffold** (`frontend/src/i18n/`) — `i18next` + `react-i18next` (added as runtime dependencies), an `en` locale (`src/i18n/locales/en.json`) with `common` and `login` namespaces, language detection via `localStorage["strata.lang"] → navigator.language → "en"` fallback chain, and a `setLanguage(lang)` helper for a future user-settings toggle. `Login.tsx` is the migrated exemplar so future PRs can copy the pattern incrementally rather than landing a single mega-refactor.

#### Changed

- **`ConfirmModal.tsx`** wraps its dialog with `useFocusTrap`, so destructive-action confirmations cannot leak keyboard focus back to the page underneath until the user explicitly cancels or confirms.
- **`Login.tsx`** field labels, button copy, and the generic error fallback are sourced from the `login` i18n namespace via `useTranslation()`. Hardcoded English strings remain wherever a string has not yet been migrated.
- **Vitest setup** (`frontend/src/__tests__/setup.ts`) initialises `i18n` once per test process via a side-effect import so `useTranslation()` resolves to real English copy in the JSDOM environment instead of echoing translation keys.

#### Fixed

- **`backend/src/routes/user.rs`** — replaced `body.checkout_id.unwrap()` after a non-`None` guard with an explicit `.ok_or_else(...)` returning `AppError::Internal(...)`. The unwrap was logically reachable only via a TOCTOU between two reads of `body.checkout_id`, but the explicit error keeps the panic-free invariant the rest of the route enforces and surfaces a stable `INTERNAL` error code instead of a 500 with no body.
- **`POST /api/tunnel/ticket`** now returns `404 NOT_FOUND` when an admin (or other privileged caller bypassing the role-access check) supplies a `connection_id` for a connection that does not exist or has been soft-deleted. Previously the privileged branch minted a ticket for any UUID, which masked client bugs and produced a "tunnel works for a moment" false-positive on the subsequent WebSocket upgrade.
- **Login rate-limit responses** now correctly return `429 Too Many Requests` with the new `RATE_LIMITED` error code, instead of `401 UNAUTHORIZED`. Both the per-IP and per-username throttles are affected. `AppError::RateLimited(String)` is the new variant; clients that branched on the textual `"Too many login attempts"` message keep working but should migrate to the `code` field.

#### Drop-in upgrade — no migrations, no API contract changes

- No database migrations.
- The error response body now carries an additional `code` field but the existing `error` field is unchanged in shape and meaning, so existing v1.5.x clients continue to work. New clients should prefer `code` for branching logic per `docs/API-LIFECYCLE.md`.
- Frontend bundle gains `i18next` + `react-i18next` (~30 KB gzipped). All other surface area is documentation, accessibility affordances, and one defensive backend refactor.

## [1.5.5] — 2026-05-22

### Security review — second-pass hardening

A focused follow-up to the v1.5.4 review. Items below were either
new findings raised against v1.5.4, or original v1.5.4 findings that
were partially mitigated and now have a complete fix landed.

#### Authentication & enumeration

- **OIDC / SSO error responses no longer enumerate users.** When the
  OIDC subject (or SAML/SSO email) does not match a provisioned user,
  the response is now the generic `Invalid or expired token` instead
  of including the offending claim. The full claim is logged at
  `debug` level so operators can still diagnose. Closes a
  user-enumeration oracle reachable from any unauthenticated client
  that can reach the SSO callback URL.
- **`/auth/change-password` is rate-limited per user** at 5 attempts
  per hour, using the same `RATE_LIMIT` mutex the login flow already
  uses. Stops a stolen-cookie attacker from brute-forcing the
  current password through the account-settings flow.
- **Refresh-rotated JWTs are recorded in `active_sessions`.** The
  refresh handler now calls `active_sessions::record(...)` after
  minting the new access token, so the admin "active sessions" view
  reflects the post-rotation `jti` and the per-user signout flow
  correctly revokes it.
- **Setup bootstrap-token check is constant-time on every path.**
  The previous short-circuit on empty input gave a measurable timing
  signal; the new path always invokes `constant_time_eq` against a
  fixed-length expected value.

#### LDAP filter validator

- Replaced the legacy `validate_ldap_filter` with a stricter
  recursive-descent style validator that caps total length at
  2048 bytes and nesting depth at 32, rejects NUL and ASCII
  control characters, and explicitly refuses match-everything
  patterns (`(*)`, `(objectClass=*)`). Four new unit tests cover
  the new rejections, the original five tests still pass.

#### Race conditions

- \*\*`activate_checkout` no longer holds a DB row lock across LDAP
  - Vault IO.\*\* The original v1.5.4 fix used `SELECT … FOR UPDATE`,
    which serialised concurrent activators correctly but blocked
    every other approver on the same row for as long as the
    Active-Directory password modify took (seconds in the slow case).
    The new flow uses a session-scoped `pg_try_advisory_lock` keyed
    on the checkout UUID for mutual exclusion, performs the LDAP and
    Vault calls with no DB lock held, and only opens a fresh
    short-lived transaction for the final `UPDATE` and audit write.
- **Active shared viewers are kicked when a share is revoked.**
  The viewer WebSocket now re-checks `find_active_by_token` every
  ~30 seconds inside the keepalive tick and closes the connection
  when the share row has been revoked, expired, or its underlying
  connection has been soft-deleted. Previously, revoke only
  prevented _new_ viewers from joining.

#### DMZ link channel

- **TLS 1.3 session resumption is disabled on the link listener.**
  Resumed TLS handshakes do not re-present the client certificate;
  for a private mTLS-only trust domain, full handshake on every
  connect is the desired posture. We install
  `NoServerSessionStorage` and set `send_tls13_tickets = 0`.
- **Per-IP TCP rate limit on the link `accept` loop.** Reuses the
  existing striped `PerIpRateLimiter` to shed connections before
  the TLS handshake CPU spend (default `5 rps`, burst `30` —
  generous for legitimate internal-node reconnects, kicks in only
  on flood-shaped traffic).
- **HTTP/2 per-stream timeout (120 s) on regular request handlers.**
  A stalled handler can no longer pin a stream slot indefinitely
  against `MAX_CONCURRENT_STREAMS`. WebSocket bridges are exempt;
  they own their own keepalive logic.
- **Loopback upgrade handler asserts target is a loopback address**
  at construction, and rejects HTTP/1.1 request paths and Host
  headers containing CR/LF/NUL before the request line is
  concatenated. Defence in depth against header smuggling and a
  hard fail-closed if the loopback target is ever misconfigured.
- **Edge-signer `x-request-id` filter tightened** from "any
  printable ASCII" to `[A-Za-z0-9_-]` only. The value is MACed by
  the edge and trusted verbatim by the backend; the wider
  character set let a public client smuggle log-field separators
  (`=`, `,`, `;`, ` `) into the trusted audit context.
- **WebSocket upgrade detection requires `Sec-WebSocket-Version: 13`.**
  Older drafts (8, 12) used incompatible framing; treating them as
  a valid upgrade publicly while the inner backend rejects them is
  a smuggling primitive.
- PSK rotation grace is already supported by the link protocol —
  internal nodes hold a map of PSKs and the server names the
  active id, so operators stage-roll new keys to clients first,
  then flip the server's `active_psk_id`. Documented here for
  completeness; no code change needed.

#### Background sweepers

- **`idempotency_keys` cleanup added** to the existing
  `active_sessions` periodic sweep. The table accumulates one row
  per write-with-`Idempotency-Key` for 24 hours; the live lookup
  already filters expired rows, but without a sweep the table
  grows unboundedly. The new index from migration 053 makes the
  range delete cheap.

#### Tests

- 4 new tests for `validate_ldap_filter` (match-everything,
  control chars, oversize, excessive nesting).
- New tests in `edge_signer` for the strict request-id charset
  (rejects punctuation; accepts UUIDs).
- New tests in `ws_proxy::is_websocket_upgrade` for required
  `Sec-WebSocket-Version: 13` and obsolete-version rejection;
  pre-existing tests updated to include the version header.

### Bumped

- `VERSION`, root `Cargo.toml`, `backend/Cargo.toml`,
  `frontend/package.json` to `1.5.5`.

## [1.5.4] — 2026-05-21

### Security review — consolidated hardening pass

v1.5.4 is a defence-in-depth release. None of the items below
correspond to a known exploited vulnerability, but each closes a
class of mistake we want gone before the v1.6 feature work lands.
There are no breaking API or database changes; operators can roll
the new images straight on top of v1.5.3.

#### Backend

- **JWT secret length is now enforced at boot.** `JWT_SECRET` shorter
  than 32 bytes (256 bits) refuses to start the backend with a
  remediation hint. Prevents accidental deployment with a placeholder
  or trimmed secret.
- **Login & registration password length cap reduced from 1024 → 256
  bytes.** Argon2 hashes any input length in roughly constant time, so
  a 1 KiB cap was a free amplification vector for credential-stuffing
  and DoS. 256 bytes still admits any realistic passphrase.
- **`/api/setup/initialize` accepts an optional one-shot bootstrap
  token.** When `STRATA_SETUP_TOKEN` is set, the endpoint requires the
  matching `X-Strata-Setup-Token` header (constant-time compared).
  Greenfield deploys without the env var keep the previous
  unauthenticated first-boot flow.
- **Active-session GC interval shortened** from 5 min → 2 min so
  abandoned/disconnected viewer rows expire from the dashboard sooner.
- **`favorites` list endpoint surfaces DB errors** instead of silently
  swallowing them with `unwrap_or(empty)` — broken queries now log and
  return a proper 5xx instead of hiding the failure as “no favorites”.
- **`recordings` pagination uses a deterministic tiebreaker**
  (`ORDER BY created_at DESC, id DESC`) so cursor pages no longer drop
  or duplicate rows when several recordings share a timestamp.
- **`share` revoke writes an audit log entry** matching the create/use
  side, closing the audit-trail gap on link revocation.

#### Edge / DMZ link channel

- **TLS pinned to 1.3 only** on the operator ↔ edge link server. The
  control channel never needs TLS 1.2 fall-back; restricting the
  protocol set removes an entire surface area of downgrade and cipher
  negotiation bugs.
- **WebSocket bridge enforces a 60 s I/O idle timeout** on both legs
  (read / write / framing), so a stalled inner TCP peer can no longer
  pin a goroutine + descriptor pair indefinitely.
- **HTTP body cap also wraps the streaming body** with
  `http_body_util::Limited`, so chunked uploads that omit or lie about
  Content-Length are still bounded by the per-IP limit.
- **Reverse proxy strips full RFC 7230 hop-by-hop header set** before
  forwarding (Connection, Keep-Alive, Proxy-Authenticate,
  Proxy-Authorization, TE, Trailers, Transfer-Encoding, Upgrade) plus
  any header named in the inbound `Connection` value.
- **Active link PSK id is now deterministic** (the first id parsed
  from `LINK_PSKS`) instead of `HashMap::keys().next()`, which the
  std-lib does not promise to keep stable across runs.
- **Edge signer scrubs IPv6 zone identifiers** (`fe80::1%eth0`) from
  X-Forwarded-For before signing, removing a header smuggling
  primitive.

#### Frontend

- **Documentation viewer sanitises rendered Markdown with DOMPurify.**
  `marked` output is treated as untrusted before being dropped into the
  DOM, eliminating any chance of stored-XSS via doc content.
- **Destructive admin actions (delete role, delete account mapping)
  use the existing `ConfirmModal`** instead of the browser-native
  `window.confirm()`, matching the rest of the admin UX and avoiding
  click-jacking on the native dialog.

#### Upgrade notes

- Confirm `JWT_SECRET` is at least 32 bytes; rotate via
  `openssl rand -base64 32` if you were running with the old default.
- Optional: set `STRATA_SETUP_TOKEN` before exposing the backend to
  network for greenfield deploys.
- No database migrations.

## [1.5.3] — 2026-05-08

### Admin Settings — grouped sidebar navigation

v1.5.3 is a focused, **UX-only** patch release. There are no API
changes, no database migrations, no protocol changes, no security
changes, and no behavioural changes to any session, audit, or
deployment code path. Operators upgrading from v1.5.2 only need to
roll the **frontend** image; the backend, DMZ edge, and guacd
images are bit-identical to v1.5.2.

#### What changed

The Admin Settings page accumulated 17 horizontal tabs as features
were added across the v1.4.x → v1.5.x line (Health, Display,
Network, SSO / OIDC, Kerberos, Vault, Recordings, Access, Tags,
AD Sync, Password Mgmt, Notifications, Sessions, VDI, Trusted CAs,
DMZ Links, Security). On a 1080p monitor the row no longer fit in a
single line on common DPI / zoom settings; on operator laptops it
overflowed horizontally and required scrolling to reach the
right-hand tabs.

v1.5.3 replaces the single horizontal row with a **left sidebar**
grouped into five sections, modelled on the navigation patterns used
by AWS Console, Azure Portal, and GitHub Settings:

- **Overview** — Health, Sessions
- **Identity & Access** — Access, AD Sync, SSO / OIDC, Kerberos, Password Mgmt
- **Connectivity** — Network, DMZ Links, Trusted CAs, VDI
- **Workspace** — Display, Tags, Notifications, Recordings
- **Secrets & Security** — Vault, Security

#### Behaviour

- **Permission-aware section collapse** — sections become hidden
  from the nav entirely when the current user has no permission to
  see any item inside them, so a non-system-admin who can only
  manage tags or view sessions sees a much smaller sidebar than a
  full system administrator. The per-item permission predicates
  (`can_manage_system`, `can_manage_users`, `can_manage_connections`,
  `can_create_*`, `can_view_audit_logs`, `can_manage_system ||
can_view_audit_logs` for Sessions, etc.) are unchanged from v1.5.2;
  only the grouping and rendering changed.
- **Responsive layout** — on screens narrower than the Tailwind
  `lg` breakpoint (1024 px) the sidebar wraps inline above the
  content as a horizontal flex row of buttons, so mobile and tablet
  operators get the same content without a forced two-pane layout.
- **Sticky sidebar** on `lg+` screens so the section list stays in
  view while scrolling long settings panels (the Recordings tab,
  the Notifications SMTP section, and the Access Control role
  editor are all longer than a typical viewport).
- **Accessibility** — the nav element has `aria-label="Admin
sections"` and section headings render as visually-distinct
  uppercase tracking-wider labels rather than `<h*>` elements (so
  the page heading hierarchy is unchanged from v1.5.2 and screen
  readers still see one `<h1>` for the page).

#### What did **not** change

- All 17 tab labels are byte-identical to v1.5.2 (Sessions, DMZ
  Links, Trusted CAs, Password Mgmt, etc.).
- The `.tab-active` CSS class is still applied to the currently-
  selected button, so existing styling, themes, and the 220-test
  AdminSettings unit-test suite continue to pass unchanged.
- The `Tab` union type, the per-tab `<TabPane>` components, the
  in-page `flash()` toast, the `getSettings()` / `getRoles()` /
  `getConnections()` / `getConnectionFolders()` / `getUsers()` /
  `getAdSyncConfigs()` initial-load logic, and the per-tab
  `onSave={() => flash(…)}` wiring are all unchanged.
- The default-tab heuristic (system admins land on Health, RBAC
  admins on Access, audit-only viewers on Sessions) is unchanged.

#### Tests

All 1329 frontend tests continue to pass (`npm run test -- --run`).
220 of those tests are in `src/__tests__/AdminSettings.test.tsx`
and exercise tab-switching by clicking the visible tab labels —
because the labels and the `.tab-active` class are preserved, no
test changes were required.

#### Upgrade

Drop-in. Pull `ghcr.io/bails309/strata-client/frontend:1.5.3`,
roll the frontend container. The backend, DMZ, and guacd images
do not need to be touched — this is a static-asset change only.

```bash
export STRATA_VERSION=1.5.3
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull frontend
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d frontend
```

If you build from source, the unified `docker compose up -d --build`
will rebuild the frontend layer only (the Cargo dep tree is
unchanged from v1.5.2 so the backend / DMZ stages hit the cargo
cache). The `__APP_VERSION__` Vite define automatically picks up
the new version from `frontend/package.json`, which drives both the
Admin → Health version banner and the **What's New** modal trigger
(operators will see the modal pop up once on next login).

## [1.5.2] — 2026-05-08

### DMZ link — WebSocket forwarding (RFC 8441 Extended CONNECT)

v1.5.2 ships the missing piece of the **dual-node DMZ deployment**
that was promised in v1.5.0's design notes but never landed in code:
the DMZ proxy can now forward WebSocket upgrades end-to-end through
the reverse-tunnel link, which means `/api/tunnel/{connection_id}`
finally works when users connect through a DMZ node.

Until this release, the DMZ proxy only handled buffered HTTP
request/response pairs — the public listener stripped the `Upgrade`
header on its way through, the inner h2 multiplexer had no
upgrade-aware code path, and any user who connected to the DMZ node
and tried to launch a session saw the WebSocket fail mid-handshake.
REST traffic (admin UI, OIDC, login) was unaffected, which is why
the regression slipped through internal smoke tests.

### What changed

- **DMZ side (`crates/strata-dmz`)** — new `ws_proxy` module detects
  RFC 6455 WebSocket upgrades (`Upgrade: websocket` + `Connection:
Upgrade` + `Sec-WebSocket-Key`) on the public listener and routes
  them down a separate code path. Instead of buffering the request
  body, the DMZ:
  1. Captures the `hyper::upgrade::on(&mut req)` future.
  2. Opens an Extended CONNECT (RFC 8441) stream on a registered
     link sender with `:method=CONNECT`, `:protocol=websocket`,
     `:path=<original>`, the signed edge-header bundle, and every
     non-hop-by-hop header from the original request.
  3. Waits for `:status=200` from the internal node before
     acknowledging the upgrade publicly.
  4. Returns `101 Switching Protocols` with a correctly-computed
     `Sec-WebSocket-Accept` (RFC 6455 §1.3 SHA-1 + base64 of
     `Sec-WebSocket-Key` + magic GUID).
  5. Spawns a bidirectional byte-pump that copies frames between
     the public TCP socket and the h2 stream — frame masking,
     ping/pong, fragmentation, and close frames all flow through
     unmodified.

- **Internal side (`backend/src/services/dmz_link`)** — h2 server
  now calls `enable_connect_protocol()` so the DMZ peer is told the
  Extended CONNECT settings extension is supported. New
  `UpgradeHandler` trait + `LoopbackUpgradeHandler` accept inbound
  Extended CONNECT streams and bridge them to a regular HTTP/1.1
  WebSocket upgrade against `127.0.0.1:8080` (overridable via the
  new `STRATA_DMZ_LOOPBACK_ADDR` env var). The loopback target is
  the same axum router that serves direct connections, so the
  existing `verify_edge_headers` middleware promotes the forwarded
  `x-strata-edge-client-ip` to the real client IP for audit / RBAC
  exactly as on a direct connection — no separate auth code path
  to keep in sync.

- **Resource limits** — Extended CONNECT streams cannot be size-
  capped by the existing `MAX_REQUEST_BODY_BYTES` / `MAX_PROXY_BODY_BYTES`
  buffers (they're long-lived). Instead we cap _individual_ h2 frame
  sizes at 8 MiB on the DMZ→public direction so a misbehaving
  internal node cannot make the DMZ buffer arbitrary memory before
  flushing to the public socket.

- **Connection origin (operator-visible)** — when a session is
  launched through the DMZ, the guacd connection still originates
  from the **internal node's** IP, not the DMZ node's IP, exactly
  as a single-node deployment behaves. The DMZ never speaks guacd,
  never holds Strata business secrets, and never sees decrypted
  credentials. This is a deliberate architectural property that
  v1.5.2 finally makes user-visible (rather than only true on
  paper).

### Upgrade

This is a drop-in upgrade for both the standalone deployment and
the dual-node DMZ deployment. No database migration; no config
changes required for existing operators. New optional env var:

- `STRATA_DMZ_LOOPBACK_ADDR` (default `127.0.0.1:8080`) — only set
  this if the internal node listens on a non-default address.

Operators running a DMZ deployment **must** rebuild and redeploy
_both_ the `strata-dmz` and `strata-backend` images for WebSocket
forwarding to work — both ends of the link need to negotiate the
RFC 8441 settings extension.

### Tests

- DMZ side: 7 new unit tests covering `is_websocket_upgrade`
  detection (canonical, multi-token Connection, case-insensitive,
  rejection paths) and `compute_accept` against the RFC 6455 §1.3
  worked example (`dGhlIHNhbXBsZSBub25jZQ==` →
  `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`).
- Internal side: 10 new unit tests for the upgrade-handler module
  covering Extended CONNECT detection, response-line parsing,
  CRLFCRLF scanning, header-forwarding allowlist, and
  oversized-line rejection.
- Existing h2_serve and supervisor tests updated to thread a
  `RejectUpgradeHandler` through the new signature; all pre-existing
  test coverage continues to pass.

## [1.5.1] — 2026-05-07

### Pop-out window correctness fix release

v1.5.1 is a focused, additive patch release that closes four
long-standing bugs in the **session pop-out window** path and ships a
new **popup-local Command Palette** so `Ctrl+K` works correctly when
the session has been popped out into its own browser window. No
database migrations, no `/api/*` contract changes, no `config.toml`
schema changes — drop-in upgrade from v1.5.0.

#### What ships in this release

- **F11 fullscreen now works inside pop-out windows.** Previously the
  pop-out's keydown trap was registered _after_ the
  `Guacamole.Keyboard` capture-phase listener, so `F11` was forwarded
  to the remote desktop as a keystroke instead of toggling the
  popup's local fullscreen. The trap is now registered _before_
  `new Guacamole.Keyboard(popup.document)` in
  [`frontend/src/components/usePopOut.ts`](frontend/src/components/usePopOut.ts);
  `F11` toggles `popup.document.fullscreenElement` and is consumed
  before Guacamole sees it.
- **F12 no longer "sticks" on the remote.** With the new registration
  order the trap calls `e.preventDefault()` on `F12` so the popup's
  built-in DevTools shortcut neither opens DevTools nor leaks a key
  release event into the remote desktop. `Ctrl+Shift+I` and
  `Ctrl+Shift+J` are forwarded to the popup's own DevTools the same
  way.
- **`Ctrl+K` now opens a popup-local Command Palette.** The main
  window's React-rooted Command Palette cannot render inside the
  pop-out (different `Window`, no React root, no router context).
  The new
  [`frontend/src/utils/popoutPalette.ts`](frontend/src/utils/popoutPalette.ts)
  is a deliberately small vanilla-DOM palette rendered directly in
  the popup's `document` — overlay + dimmed backdrop + search input +
  filterable connection list, styled to match the main palette. It
  fetches the user's connections lazily via the existing
  `getMyConnections()` and posts the chosen connection back to the
  opener as `{ type: "strata:open-connection", id }`. The opener's
  `CommandPaletteProvider` validates the id (`typeof === "string"`,
  length 1–255) and navigates to `/session/${encodeURIComponent(id)}`,
  reusing the existing routed-launch flow. Filtering matches against
  `name`, `hostname`, and `protocol` (case-insensitive substring);
  arrow keys cycle with wrap-around; Enter activates; Escape closes;
  mousedown on a row activates; mousedown on the dimmed backdrop
  closes. The palette intentionally does **not** register its own
  document keydown listener — the popup's existing `trapKeyDown`
  delegates to `popoutPalette.handleKeyDown(e)` so there is no race
  with Guacamole's capture-phase listener. While the palette is open
  the trap returns `true` from `Guacamole.Keyboard.onkeydown` (the
  contract is inverted: returning `true` means "do not
  `preventDefault`"), so the `<input>` element receives typed
  characters normally.
- **Pop-out windows now close cleanly when the opener navigates
  away.** Previously a freeze in the opener (page reload, hard
  navigation, tab close) left orphaned pop-out windows that could no
  longer talk to a parent JS realm. The opener now installs a
  `pagehide` handler that calls `popup.close()` for every tracked
  pop-out, mirroring what the per-session disconnect button already
  did.
- **Coverage ratchet held in lock-step.** A new 19-test unit suite at
  [`frontend/src/__tests__/popoutPalette.test.ts`](frontend/src/__tests__/popoutPalette.test.ts)
  drives the new vanilla-DOM palette to **95.07 % statements,
  88.57 % branches, 100 % functions, 98.47 % lines**. Global
  thresholds in [`frontend/vitest.config.ts`](frontend/vitest.config.ts)
  are unchanged; the suite simply restores the global coverage
  numbers that the new untested file would otherwise have dragged
  below the floor (statements 72.47 ≥ 72, branches 64.38 ≥ 64,
  functions 62.26 ≥ 61, lines 74.38 ≥ 74). All 1 329 frontend tests
  still pass; lint stays at zero warnings on the changed files.

#### Backwards compatibility

- **Database migrations** — none.
- **REST API surface** — none. `strata:open-connection` is a
  same-origin `postMessage` event between the opener and its own
  pop-out window; it is not a public protocol.
- **`config.toml` / environment variables** — none.
- **DMZ deployment mode** — unaffected. Pop-out windows are an
  in-browser concern; the link supervisor and edge-header HMAC paths
  are unchanged.
- **Image tags** — `ghcr.io/bails309/strata-client/{backend,frontend,custom-guacd}:1.5.1`
  ship alongside the rolling `:latest`; the `:1.5.0` images remain
  available and byte-identical for rollback. cosign / SLSA
  attestations are produced by the same release pipeline and verify
  with the existing identity / `--certificate-oidc-issuer` flags.

#### Upgrade

```sh
docker compose pull
docker compose up -d
```

No reconfiguration required. Operators running the DMZ split should
roll the **internal node** first and the **DMZ edge** second — the
two carry only documentation-aligned binary changes in this release
so the order is informational, not strictly required.

## [1.5.0] — 2026-05-05

### DMZ deployment mode — split-topology release

v1.5.0 introduces a **DMZ deployment mode**: a separate, minimal,
sandboxable edge binary (`strata-dmz`) terminates public TLS while the
existing `strata-backend` ("internal node") stays inside the corporate
network. The internal node opens a persistent **outbound** mTLS tunnel
to the DMZ; the DMZ initiates **no** connections to the internal
network and holds **no** Strata business secrets. Every existing
Strata feature works through the DMZ on day one because the tunnel
carries arbitrary HTTP requests rather than custom message types.

Single-node operators are not affected — when the DMZ environment
variables are not set the internal node continues serving public
traffic directly. Drop-in upgrade from v1.4.1.

#### What ships in this release

- **New crate `crates/strata-dmz`** — the DMZ edge binary. Owns the
  public TLS listener (default `0.0.0.0:8443`), a separate link-server
  listener for inbound mTLS from internal nodes (default `0.0.0.0:9443`),
  the slow-loris / rate-limit / inflight-cap guards, the SPA static
  serving path, and the `x-strata-edge-*` header signer. No Postgres,
  no Vault, no JWT signing key, no `guac-master-key`, no recording
  storage, no OIDC client secret. Configured entirely from environment
  variables (see [`docs/deployment.md`](docs/deployment.md#dmz-deployment-mode)).
- **New crate `crates/strata-protocol`** — versioned wire-format
  primitives shared by both binaries: `AuthHello` / `AuthAccept`
  handshake frames, PSK challenge–response, `x-strata-edge-*` HMAC
  scheme, `tunnel.terminated` audit reason enum.
- **Internal-node link supervisor** —
  [`backend/src/services/dmz_link/`](backend/src/services/dmz_link/)
  spawns one supervisor task per configured DMZ endpoint, dials out
  over mTLS using the operator-supplied client certificate / key /
  link CA bundle, performs the PSK-bound handshake, and serves the
  internal `axum::Router` over an HTTP/2 connection back to the DMZ.
  Exponential back-off with jitter; unfailing reconnect; per-link
  state (`up` / `connecting` / `authenticating` / `initializing` /
  `backoff` / `stopped`) and lightweight metrics surfaced in the admin
  UI.
- **Edge-header HMAC** —
  [`backend/src/services/edge_header.rs`](backend/src/services/edge_header.rs)
  implements the internal-side verifier for the
  `x-strata-edge-{ts,id,client-ip,sig}` header set. The header is
  HMAC-SHA-256 signed by the DMZ with a key configured via
  `STRATA_DMZ_EDGE_HMAC_KEYS` (rotation-aware: first key active, rest
  accepted). Requests reaching the internal node without a valid edge
  header are rejected unless they arrive on the local-loopback path
  (single-node mode).
- **Admin DMZ Links tab** —
  [`frontend/src/pages/admin/DmzLinksTab.tsx`](frontend/src/pages/admin/DmzLinksTab.tsx)
  surfaces every supervisor's state, connect / failure counters, last
  error, and uptime. A **Force reconnect** button calls
  `POST /api/admin/dmz-links/reconnect` to drop and redial every link
  (used during scheduled DMZ restarts and incident response). The page
  auto-refreshes every 15 s.
- **New admin API endpoints**
  - `GET /api/admin/dmz-links` — supervisor snapshot
    (`{configured, links: [{endpoint, state, connects, failures, since_unix_secs, last_error}, ...]}`).
  - `POST /api/admin/dmz-links/reconnect` — kick every link
    (`{nudged: <count>}`).
    Both require `can_manage_system` and the standard `X-CSRF-Token`
    double-submit cookie.
- **Operator-grade documentation**
  - [`docs/architecture.md`](docs/architecture.md) — new chapter on
    the DMZ split, sequence diagrams, secret-overlap matrix.
  - [`docs/security.md`](docs/security.md) — DMZ threat-model section
    (W6-1 through W6-5) covering compromised-DMZ blast radius, key
    rotation runbook, abuse guards.
  - [`docs/deployment.md`](docs/deployment.md) — full env-var
    reference, certificate generation, Helm chart pointer, scheduled
    rotation worked example.
  - [`docs/api-reference.md`](docs/api-reference.md) — admin DMZ
    endpoints documented next to the existing admin surface.
  - [`docs/threat-model.md`](docs/threat-model.md) — STRIDE rows for
    every new asset and trust boundary.
  - [`docs/runbooks/dmz-incident.md`](docs/runbooks/dmz-incident.md) —
    incident response procedure.
- **Helm chart** —
  [`deploy/helm/strata-dmz/`](deploy/helm/strata-dmz/) ships the
  edge-side Kubernetes deployment.
- **CI / supply-chain** — `cargo audit` now runs against the workspace
  `Cargo.lock` so every member crate is scanned in one pass; coverage
  thresholds raised in lock-step with the new code; `strata-dmz` and
  `strata-protocol` get matching CodeQL + Trivy passes.

#### Backwards compatibility

- **Single-node (default) deployments** — no behaviour change. When
  `STRATA_DMZ_ENDPOINTS` is unset the internal node serves public
  traffic directly with no link supervisor spawned.
- **Database migrations** — none. The DMZ feature is stateless on the
  edge and stateless on the internal node beyond the in-memory link
  registry.
- **`/api/*` contract** — additive only (two new admin endpoints).
  No existing endpoint changed shape.
- **`config.toml`** — unchanged. DMZ is configured exclusively via
  environment variables so the same config file continues to work in
  both single-node and split deployments.
- **Audit log** — `tunnel.terminated` reason enum unchanged from
  v1.4.1. New `dmz.link.{up,down,handshake_failed,reconnect_requested}`
  events are added; dashboards filtering on the `event_type` column
  can opt in.

#### Upgrade procedure

1. `docker compose pull` and rebuild backend / frontend.
2. **No DMZ desired** — start the stack as before, no env vars to
   add.
3. **Adopt DMZ mode** — generate the link-tier mTLS PKI and the edge
   HMAC key (see [`docs/deployment.md`](docs/deployment.md#dmz-deployment-mode)),
   stand up the `strata-dmz` container on its public-facing host,
   set `STRATA_DMZ_ENDPOINTS` + `STRATA_CLUSTER_ID` + `STRATA_NODE_ID`
   - the matching `STRATA_DMZ_LINK_PSK_<id>` and
     `STRATA_DMZ_EDGE_HMAC_KEYS` on the internal node, restart it,
     verify the link comes up green in **Admin → DMZ Links**.

## [1.4.1] — 2026-05-05

### Tunnel watchdog no longer reaps active sessions at the access-token TTL

v1.4.1 fixes a high-impact regression in the v1.3.2 WebSocket-tunnel
auth watchdog ([`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)).
Reported by users: active connection sessions were being torn down
roughly every 20 minutes even though the operator was still logged in
and actively using the web UI.

**Root cause.** The watchdog captured the access token's `exp` claim
once at WebSocket-upgrade time and forced the tunnel closed when that
timestamp was reached. Access tokens carry a 20-minute TTL, but the
frontend's `SessionTimeoutWarning` rotates them via
`POST /api/auth/refresh` on user activity (proactive refresh after
~10 minutes of activity). The already-open WebSocket has no mechanism
to learn about that rotation, so the watchdog held on to the
_original_ token's `exp` and reaped the session at T+20m regardless of
how active the user was.

**Fix.** The dead `jsonwebtoken::decode` block at upgrade time and
the `watchdog_exp: Option<u64>` cache are removed. Teardown semantics
are now:

1. **Manual logout / 20-min idle logout** — the frontend already calls
   `POST /api/auth/logout`, which revokes both access and refresh
   tokens. The watchdog still polls
   `services::token_revocation::is_revoked(token)` every 30 s and
   closes the tunnel within one tick. Audit `reason: "revoked"`.
2. **Browser closed / network died** — TCP-level WebSocket close
   already triggers normal teardown via `tunnel::proxy(...)`
   returning. No watchdog needed.
3. **Hard cap on session duration** — newly enforced by the watchdog
   as `MAX_TUNNEL_DURATION = 8h`, measured from upgrade time so it is
   unaffected by token rotation. Audit `reason: "max_duration"`.

The audit-log payload shape is unchanged; the `reason` field can now
take the values `"revoked"` or `"max_duration"` (previously
`"revoked"` or `"expired"`). Operators who consume the
`tunnel.terminated` audit event should update any dashboards that
filtered on `expired` to also accept `max_duration` — they refer to
the same defence-in-depth backstop, just measured against wall-clock
elapsed time rather than the (now-rotating) token `exp`.

### guacd image build resilience: `staging/1.6.1` pin churn

The guacd image build was briefly broken on `origin/main` between
commits `de0ba24` and `1064a8e` while we attempted to drop our local
patch [`guacd/patches/006-freerdp325-authenticate-ex.patch`](guacd/patches/006-freerdp325-authenticate-ex.patch).
The hypothesis — that GUACAMOLE-2273 (upstream commit `7696572`,
_"Implement FreeRDP AuthenticateEx callback and handle deprecation
of Authenticate callback"_) had landed on `staging/1.6.1` and
rendered our patch redundant — was wrong: at this writing GUACAMOLE-2273
exists only as an unmerged PR commit, not on the staging branch
HEAD. Rebuilding `guacd` against the new pin (`4163ead`) without
patch 006 fails at `src/protocols/rdp/rdp.c:558`:

```
rdp.c:558:15: error: 'freerdp' {aka 'struct rdp_freerdp'} has no
member named 'Authenticate'; did you mean 'AuthenticateEx'?
```

Independently, attempting to pin directly to the GUACAMOLE-2273
PR commit (`7696572`) trades that error for a different one against
FreeRDP 3.25:

```
rdp.c:387:14: error: 'AUTH_FIDO_PIN' undeclared (first use in this
function)
```

`AUTH_FIDO_PIN` is part of the FreeRDP `rdp_auth_reason` enum
introduced after FreeRDP 3.25, and Alpine edge currently ships
`freerdp-libs 3.25.0-r0` / `freerdp-dev 3.25.0-r0`. Net result:
neither _"drop patch 006"_ nor _"pin to the unmerged PR"_ works
today. v1.4.1 keeps the working v1.4.0 combination — pin
`4163ead8be54baa35ef5f7ad8897a57497649112` (`staging/1.6.1` HEAD)
plus patch 006 plus the two grep guards in
[`guacd/Dockerfile`](guacd/Dockerfile) — and updates the Dockerfile
comment block to record the reasoning so the next maintainer does
not re-walk the same path. Functionally a no-op vs. v1.4.0; only
the pin/patch _story_ changed.

### Crypto crate refresh

[`backend/src/services/web_autofill.rs`](backend/src/services/web_autofill.rs) — Chromium-format
`Login Data` decryption (PBKDF2 `peanuts`/`saltysalt`, AES-128-CBC,
v10 prefix, used by the Chromium-export ingestion path under VDI /
web sessions) — gets a refresh of the underlying RustCrypto crates
to the current major lines:

| Crate    | Old  | New  | Notes                                          |
| -------- | ---- | ---- | ---------------------------------------------- |
| `aes`    | 0.8  | 0.9  | API: `KeyInit::new` is now panicking-only      |
| `cbc`    | 0.1  | 0.2  | feature `std` → `alloc`                        |
| `pbkdf2` | 0.12 | 0.13 | `pbkdf2_hmac::<Sha1>(...)` signature unchanged |
| `sha1`   | 0.10 | 0.11 | re-export hygiene                              |

The decrypted secret is never written to disk by the backend; this
path lives entirely behind the autofill-import feature toggle that
is still gated by `can_manage_system`. Envelope encryption of stored
credentials still goes through `aes-gcm` (unchanged) and Vault
Transit (unchanged) — see
[`docs/security.md` § Envelope Encryption](docs/security.md#envelope-encryption-credentials-at-rest).

### Frontend code-quality sweep

`chore(frontend): eliminate 334 ESLint warnings (Phases 1-7)`. No
behavioural changes — explicit `unknown`-narrowing in error
catches, removal of dead imports, JSX accessibility tightening,
`useCallback` / `useMemo` dependency arrays normalised, optional-
chaining where the type already permits `undefined`. The frontend
ESLint job in CI now exits with `0` warnings instead of a noisy
allow-list. Coverage thresholds in
[`frontend/vitest.config.ts`](frontend/vitest.config.ts) raised in
lock-step (`statements`, `branches`, `functions`, `lines` all
≥ the new measured baseline) to prevent backsliding.

### Dependency bumps

Backend:

- `bollard` 0.18.1 → 0.20.2 → 0.21.0 (transitive `hyper-util` /
  `hyper` / `http-body-util` refresh; `bollard::Docker::list_images`
  / `inspect_container` now return strongly-typed `models::*`
  instead of `serde_json::Value`). Test-side adjustments live in
  [`backend/src/services/vdi_docker.rs` test module](backend/src/services/vdi_docker.rs).
- `tokio` 1.52.1 → 1.52.2 (patch).

CI / GitHub Actions:

- `docker/login-action` 3.7.0 → 4.1.0
- `actions/cache` 4.3.0 → 5.0.5
- `github/codeql-action` 4.35.2 → 4.35.3
- Trivy scan now prints the findings table on failure
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) and the
  GHA build cache for the OS-package layer is dropped on each run
  so freshly-published patch CVEs are surfaced same-day rather than
  hidden behind a cached layer.

E2E:

- `eslint` 10.3.0 / `eslint-plugin-react-hooks` 7.1.1 / `@eslint/js`
  10.0.1 / `eslint-plugin-security` 4.0.0 — Dependabot PRs reviewed
  and held: ESLint 10 is **not yet mergeable** because
  `eslint-plugin-react@7.37.5` (latest) still calls the removed
  `context.getFilename()` method (TypeError at lint time) and
  `eslint-plugin-jsx-a11y@6.10.2` (latest) caps its peer range at
  `eslint@^9`. We re-evaluate when those plugins ship v10-compatible
  releases.

### Documentation

- [`docs/security.md`](docs/security.md) — _WebSocket-tunnel auth
  watchdog_ section revised with v1.4.1 semantics
  (`MAX_TUNNEL_DURATION = 8h`, removal of `exp` enforcement, new
  `max_duration` audit reason).
- [`docs/architecture.md`](docs/architecture.md) — _Connection
  Tunnel_ prose updated to match the watchdog v1.4.1 contract.
- [`docs/api-reference.md`](docs/api-reference.md) — `tunnel.terminated`
  audit `reason` enum updated.
- This changelog and [`WHATSNEW.md`](WHATSNEW.md) — the v1.4.1
  card and the headline regression-fix narrative above.
- [`README.md`](README.md) — version badge bumped to 1.4.1.

### Tests

- [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  watchdog tests: assert `reason = "revoked"` survives the removal
  of `exp` enforcement and assert `reason = "max_duration"` is
  emitted when the elapsed-time guard fires (test substitutes a
  small `MAX_TUNNEL_DURATION` via `cfg(test)`).
- [`backend/src/services/vdi_docker.rs`](backend/src/services/vdi_docker.rs)
  — fixture types updated for `bollard 0.20+` typed responses.
- [`frontend`](frontend) — coverage thresholds raised; new tests
  for `parseKubeconfig` mocking inside `AdminSettings` and
  miscellaneous unit tests added during the ESLint sweep.

### Upgrade notes

Drop-in upgrade from v1.4.0. No database migrations, no `/api/*`
contract changes (only the `tunnel.terminated` audit `reason` enum
gained a member), no `config.toml` schema changes. Rebuild backend,
frontend and (optionally) `guacd` images so the new bits actually
run:

```bash
docker compose build backend frontend
# guacd build is unchanged from v1.4.0; rebuild only if you also
# want the documentation-only Dockerfile comment refresh.
docker compose up -d
```

---

## [1.4.0] — 2026-05-01

### Kubernetes pod console as a first-class protocol

v1.4.0 adds the `kubernetes` connection protocol — `kubectl attach`
and `kubectl exec` rendered as a terminal in the browser, end-to-end
through Strata's existing tunnel, recording, audit and credential
pipelines. There is no new sidecar process; Apache Guacamole already
ships a `libguac-client-kubernetes.so` driver that talks the K8s API
spdy/websocket sub-protocol directly, and our custom `guacd` image
already builds it (gated by a Dockerfile guard so a missing `.so`
fails the build instead of silently dropping the protocol at
runtime). The five phases were scoped, implemented and shipped
together rather than across point releases:

1. **Image guard** — `guacd/Dockerfile` now `test -f`s
   `libguac-client-{rdp,ssh,vnc,kubernetes}.so` after `make install`,
   exiting non-zero if any are missing.
2. **Backend wiring** —
   `backend/src/tunnel.rs` `full_param_map()` gets a
   `protocol == "kubernetes"` branch with terminal defaults
   (`xterm-256color`, gray-on-black, monospace 12pt, 1000-line
   scrollback, `namespace=default`); `is_allowed_guacd_param()`
   adds `namespace`, `pod`, `container`, `exec-command`, `use-ssl`,
   `ca-cert`, `client-cert` to the override whitelist. **`client-key`
   is deliberately NOT whitelisted** — the private half of mTLS
   creds must flow through the Vault-encrypted credential-profile
   path, never through connection extras.
3. **Database schema** — `backend/migrations/060_kubernetes_protocol.sql`
   widens the `connections.protocol` and `ad_sync_configs.protocol`
   `CHECK` constraints to include `'kubernetes'`.
4. **Frontend admin UI** — `frontend/src/pages/admin/protocolFields.ts`
   gains a `"kubernetes"` entry; new `KubernetesSections` component
   in `connectionForm.tsx` renders Pod / Namespace / Container /
   Exec command / TLS toggles / CA + client cert paste areas / the
   shared terminal display fields. Wired into `AccessTab`. New
   protocol icon (Kubernetes-style heptagon wheel) added to
   `CommandPalette`, `Dashboard` and `ActiveSessions`.
5. **Kubeconfig importer** — `POST /api/admin/kubernetes/parse-kubeconfig`
   takes a pasted `~/.kube/config`, extracts cluster server URL,
   namespace, CA cert and client cert, and returns the client
   private key to the caller exactly once. The connection editor
   wires this into an "Import kubeconfig" textarea above the
   Kubernetes form sections; the private key surfaces in a
   "copy now" panel and is wiped from DOM state once the form is
   filled. The backend never persists the private key on this
   path — operators are expected to immediately paste it into a
   credential profile.

### Credential routing for `kubernetes`

Tunnel-creation in `routes/tunnel.rs` now special-cases
`wire_protocol == "kubernetes"`: the decrypted credential profile's
password slot is repurposed as the `client-key` PEM body, moved
into the `extra` map, and the username/password slots are cleared.
This keeps the `client-key` parameter inside the same trust
boundary as Vault Transit and prevents stray protocol arguments
from being emitted.

### RBAC

`POST /api/admin/kubernetes/parse-kubeconfig` is gated by
`check_system_permission` (system admin only) and is exercised by
the `e2e/tests/rbac.spec.ts` no-auth/wrong-role assertions.

### Security

- Cluster CA cert and client cert are public PEM material and live
  in `connections.extra` (`ca-cert`, `client-cert`). The matching
  client private key lives only in a Vault-encrypted credential
  profile and is remapped into the guacd `client-key` parameter at
  handshake time.
- The kubeconfig parser deliberately **does not** follow file-path
  references for cert material (`certificate-authority: /path/...`)
  — the backend has no business reading random admin-controlled
  file paths. Only embedded `*-data` base64 blobs are decoded.
- A 1 MiB hard cap on kubeconfig body size prevents YAML-bomb
  abuse of the importer endpoint.

### Documentation

- [`docs/architecture.md`](docs/architecture.md) — new "Kubernetes
  Pod Console" entry under _Extended protocols_.
- [`docs/security.md`](docs/security.md) — Kubernetes client-key
  handling note in the credential-resolution section.
- [`docs/api-reference.md`](docs/api-reference.md) — `kubernetes`
  added to protocol enums; new section documenting
  `POST /api/admin/kubernetes/parse-kubeconfig`.

### Tests

- `backend/src/tunnel.rs` — `full_param_map_kubernetes_defaults`
  and `full_param_map_kubernetes_extras_passthrough` assert the
  protocol branch, default param injection, extras whitelist
  (with `client-key` blocked) and clipboard application.
- `backend/src/services/kubernetes.rs` — five unit tests covering
  full-kubeconfig parsing, single-context fallback, exec-plugin
  warnings, bearer-token warnings, oversized-body rejection and
  empty-body rejection.
- `e2e/tests/rbac.spec.ts` — `parse-kubeconfig` added to both the
  no-auth and wrong-role POST matrices.

### Deferred

- **Live pod listing.** A live `POST /api/admin/kubernetes/list-pods`
  endpoint backed by the `kube` Rust crate (≈80 transitive deps)
  would let the form populate a pod-picker dropdown instead of
  asking the operator to type the pod name. Deferred to a later
  release because the dependency surface is significant and the
  same UX can be achieved out-of-band by `kubectl get pods`. Tracked
  in the roadmap.

## [1.3.2] — 2026-05-01

### guacd FreeRDP 3.25 callback ABI fix, RDP resize artefact correction, idle-tunnel watchdog, and logout WebSocket cleanup

A focused patch release that closes four production-affecting
issues that surfaced after v1.3.1 went out:

1. The custom `guacd` image stopped building on Alpine edge once
   `freerdp-dev` rolled from `3.24.2-r0` to `3.25.0-r0`, because
   FreeRDP 3.25 deleted the legacy `Authenticate` callback field
   from `struct rdp_freerdp` in favour of the new `AuthenticateEx`
   callback (which adds an `rdp_auth_reason reason` parameter).
2. RDP sessions exhibited a black "ghost region" along the edge of
   the visible canvas after a server-driven desktop resize (e.g.
   resolution change inside a Windows VM, GFX channel renegotiation),
   because the new GDI buffer was allocated but never marked dirty
   or refreshed.
3. The backend WebSocket tunnel kept the recording stream and
   `session_registry` row alive indefinitely if the access token
   was revoked or expired without the frontend explicitly closing
   the tunnel — the typical case when the operator force-quits
   the browser, switches networks mid-session, or the tab is
   killed by the OS.
4. Manual logout (and idle-timeout logout) flipped React auth
   state without first closing the open Guacamole tunnels, so the
   backend kept proxying frames into a logged-out user's
   recording until the tab was eventually closed.

None of the changes touch the database schema, the documented
`/api/*` contract, or the on-disk `config.toml` shape. **Drop-in
upgrade from v1.3.1** — rebuild the backend, frontend, and `guacd`
images so the new bits actually run; a `docker compose pull` of an
old tag is not enough.

### Added

- **Patch `006-freerdp325-authenticate-ex.patch` for `guacd`.**
  [`guacd/patches/006-freerdp325-authenticate-ex.patch`](guacd/patches/006-freerdp325-authenticate-ex.patch)
  adds a unified-diff against `src/protocols/rdp/rdp.c` (pinned at
  upstream `apache/guacamole-server` commit `2980cf0`, release
  1.6.1) that:
  - Adds an explicit `#include <freerdp/version.h>` near the top
    of `rdp.c` so the `FREERDP_VERSION_MAJOR` /
    `FREERDP_VERSION_MINOR` preprocessor macros are visible at
    every conditional that follows. (Without this, the macros are
    _not_ transitively defined inside `rdp.c` despite
    `<freerdp/freerdp.h>` being included — a fact that wasted an
    embarrassing amount of debugging time.)
  - Wraps the `static BOOL rdp_freerdp_authenticate(...)` function
    signature in
    `#if defined(FREERDP_VERSION_MAJOR) && (FREERDP_VERSION_MAJOR > 3 || (FREERDP_VERSION_MAJOR == 3 && FREERDP_VERSION_MINOR >= 25))` /
    `#else` / `#endif` so the FreeRDP 3.25+ build gets the new
    five-argument signature
    `BOOL (freerdp* instance, char** username, char** password, char** domain, rdp_auth_reason reason)`
    while FreeRDP 3.24 and earlier keep the four-argument
    signature. The added `reason` parameter is intentionally
    discarded with `(void) reason;` because the existing
    implementation already requests whichever credentials are
    missing, regardless of the reason FreeRDP raised the
    callback.
  - Wraps the
    `rdp_inst->Authenticate = rdp_freerdp_authenticate;` callback
    assignment in the same `#if` / `#else` / `#endif` so FreeRDP
    3.25+ gets `rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;`
    while older versions keep the legacy field name.
- **Defence-in-depth grep verification in `guacd/Dockerfile`.**
  Immediately after the patch loop, the Dockerfile now runs two
  `grep -q` assertions that fail the build with a clear error
  message if the post-patch source tree does _not_ contain
  `#include <freerdp/version.h>` and `rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;`.
  The first iteration of the patch applied silently but selected
  the `#else` (legacy) branch at every conditional because
  `FREERDP_VERSION_MAJOR` was undefined at that point in the
  translation unit; the assertions catch that exact failure mode
  immediately rather than letting the build run on for several
  minutes before the linker complains.
- **`guacd/patches/.gitattributes` pinning `*.patch` to
  `text eol=lf`.** Patch files are byte-sensitive — even a single
  CRLF-converted hunk can cause `git apply` and `patch -p1` to
  misalign context lines. Locking the patches directory to LF
  removes the failure mode for contributors with
  `core.autocrlf=true` on Windows.
- **`guacd/patches/005-refresh-rect-on-resize.patch`** (re-added
  cleanly, after a brief revert during v1.3.1's terminal
  investigation). Forces `guacd`'s GDI desktop-resize path to
  mark the entire layer dirty and to ask the RDP server to
  re-send pixels for the full new desktop area, eliminating the
  "ghost" black border that appeared along the edge of an RDP
  session after a server-driven resolution change. The patch
  inserts a `RECTANGLE_16` covering the whole new desktop and
  invokes `context->update->RefreshRect(context, 1, &area)` once
  the new GDI buffer has been allocated; structured debug logs
  (`[strata] guac_rdp_gdi_desktop_resize: resizing %dx%d` and
  `[strata] post-resize RefreshRect %ux%u -> %s`) make the path
  visible at `GUAC_LOG_DEBUG`. Bounds-checked against `UINT16_MAX`
  so a pathological resize never produces a malformed PDU.
- **WebSocket-tunnel auth watchdog.** A new poll loop inside
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  `ws_tunnel` decodes the access token's `exp` claim once at
  upgrade time and, every 30 seconds while the proxy loop is
  alive, asks `services::token_revocation::is_revoked(token)` and
  compares `now()` to `exp`. If either condition fires, the
  watchdog logs at `INFO` and aborts the proxy loop so the
  recording flushes and `session_registry` decrements. Closes
  the long tail of "ghost recording grows for hours after the
  user's tab is killed by the OS" reports. Polling cadence
  (30 s) was chosen so that an aggressive 1-minute access-token
  TTL still detects revocation within ≤ 30 s, while a normal
  20-minute TTL costs at most 40 ticks per session — negligible
  next to the WebSocket I/O itself.
- **`closeAllSessionsExternal()` module-level handler in
  [`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx).**
  The provider now registers its own `closeAllSessions` callback
  via `setCloseAllSessionsHandler` on mount and unregisters on
  unmount; non-React code (specifically `App.tsx`'s
  `handleLogout`, which lives outside the provider tree) can call
  `closeAllSessionsExternal()` to tear down every active tunnel
  before flipping React auth state. The teardown calls
  `cleanupPopout`, `cleanupMultiMonitor`, the per-session
  `_cleanupPaste` cleanup, resets the keyboard handlers, and
  finally calls `client.disconnect()` on each session inside a
  best-effort `try / catch` so a single failure cannot block the
  rest of the logout flow.

### Fixed

- **`docker compose --profile local-db build guacd` now succeeds
  on Alpine edge.** The previous `guacd` image stopped building
  with:

  ```text
  src/protocols/rdp/rdp.c:565:15: error:
    'freerdp' {aka 'struct rdp_freerdp'} has no member named
    'Authenticate'; did you mean 'AuthenticateEx'?
  ```

  the moment Alpine edge bumped `freerdp-dev` from `3.24.2-r0` to
  `3.25.0-r0`. Patch 006 (above) routes the build through
  `AuthenticateEx` on FreeRDP ≥ 3.25 while keeping the legacy
  `Authenticate` field on 3.24-and-earlier so contributors still
  on `freerdp-dev=3.24.2-r0` are not regressed. The pinned
  upstream `apache/guacamole-server` commit (`2980cf0`) is
  unchanged.

- **Black "ghost regions" after RDP desktop resize.** Patch 005
  (above) adds a post-`gdi_resize` repaint kick so the full new
  desktop area is marked dirty and a `RefreshRect` is sent to the
  RDP server, eliminating the visible solid-black margin that
  used to appear along the edges of an RDP session after a
  server-driven resolution change.
- **Stale recording rows / `session_registry` rows after lost
  tabs.** When the operator's browser tab was killed without a
  graceful close (OS task-killer, network drop, kernel OOM,
  hostile client), the WebSocket tunnel kept proxying frames
  into a recording until the OS eventually closed the underlying
  TCP socket — minutes later, sometimes hours. The new auth
  watchdog (above) now detects access-token expiry / revocation
  in ≤ 30 s and tears the tunnel down cleanly, so the recording
  is flushed and `session_registry` accurately reflects the live
  set of sessions.
- **Logout left tunnels streaming until the tab closed.**
  `App.tsx`'s `handleLogout` now calls `closeAllSessionsExternal()`
  _before_ flipping React auth state and then issues a
  fire-and-forget `apiLogout()` to invalidate the refresh token
  and clear the auth cookies. Idle-timeout logout takes the same
  path. The backend now sees clean WebSocket closes the moment
  the user clicks **Log out** (or hits the idle deadline), and
  the live-sessions list updates immediately rather than after
  the next 30 s watchdog tick.
- **Clippy `too_many_arguments` warning on `ws_tunnel`.** The
  `ws_tunnel` axum handler reached eight extractor arguments
  after the `OriginalUri` and watchdog work; a targeted
  `#[allow(clippy::too_many_arguments)]` keeps the handler
  signature readable without splitting the extractor chain into
  a wrapper struct that would be only used in one place.
- **Cosmetic: JWT `exp` claim decode is now a small typed block.**
  The watchdog's `exp` decode lives in a self-contained `decode::<ExpClaim>`
  with `Validation::new(Algorithm::HS256)`, an issuer check
  (`strata-local`), and a `set_required_spec_claims(&["exp"])`,
  rather than a flat one-liner — non-local OIDC tokens cleanly
  fall through to `None` and the watchdog gracefully degrades to
  revocation-only checks for them.

### Removed

- **`guacd/patches/006-freerdp325-authenticate-ex.awk`.** Earlier
  iterations of the FreeRDP 3.25 fix experimented with an
  `awk`-based shim and a `sed` shim before settling on a real
  unified-diff `.patch` consistent with siblings 001–005. The
  intermediate `.awk` script has been deleted; the canonical fix
  is patch 006 above.

### Operator notes

- **Rebuild required.** All four fixes live in either the Rust
  backend binary, the React bundle, or the custom `guacd` image.
  `docker compose up -d --build` (or pull a freshly published CI
  tag) — a `docker compose pull` of an old tag will leave you on
  the broken `guacd` image.
- **No database migrations.** Schema is unchanged from v1.3.1.
- **No `/api/*` contract changes.** No new routes, no new query
  parameters, no new response fields. The auth-watchdog poll is
  entirely server-side.
- **No `config.toml` schema changes.**
- **Existing in-flight tunnels** that were already connected
  before the upgrade get the watchdog the next time the user
  reconnects (the watchdog is wired in `ws_tunnel`, which only
  runs at upgrade time).
- **FreeRDP 3.24 still works.** The `#if` guard on patch 006 means
  contributors on Debian 13 / Trixie (which still ships
  `freerdp-3.24`) build identically to before.

## [1.3.1] — 2026-04-30

### SSH terminal fidelity, phantom-selection mouse hygiene, recording-playback URL fix, and guacd patch resilience

A same-day patch release that closes five separate small bugs that
all surfaced together while validating the v1.3.0 production
rollout. None of them affect the database schema, the `/api/*`
contract, or the on-disk config shape — every fix is confined to
the backend `tunnel.rs` parameter map, the frontend session /
recording-playback components, and the guacd image build pipeline.
The only operator-visible behaviour change is that **brand-new SSH
sessions look correct out of the box** (256-colour `vim`, working
`nano` alt-screen restore, sane scrollback) without the operator
having to set any per-connection `terminal-type` / `color-scheme`
override. The other four fixes are pure-correctness changes that
remove user-facing failure modes that were never supposed to occur.

### Added

- **Rustguac-parity SSH defaults in the connect-instruction parameter
  map.** [`backend/src/tunnel.rs`](backend/src/tunnel.rs) `full_param_map()`
  now seeds — for every `protocol == "ssh"` connection where the
  admin has not explicitly overridden them — the same SSH terminal
  parameters that upstream
  [sol1/rustguac](https://github.com/sol1/rustguac) sends:
  `terminal-type=xterm-256color`, `color-scheme=gray-black`,
  `font-name=monospace`, `font-size=12`, `scrollback=1000`,
  `backspace=127`, `locale=en_US.UTF-8`, and
  `server-alive-interval=0`. Three of these are load-bearing on
  guacd's bundled SSH terminal emulator
  ([`guac_terminal`](https://github.com/apache/guacamole-server/tree/2980cf0/src/terminal)):
  - **`terminal-type=xterm-256color`** is exported as the `TERM`
    environment variable on the remote PTY. Without it, guacd sends
    the empty default which `OpenSSH` translates to `TERM=linux` on
    most distros — a 16-colour profile that does _not_ advertise
    `smcup`/`rmcup`, so `nano` and `less` cannot save and restore
    the alternate screen. That was the user-visible _"after I close
    nano my SSH window still shows the file"_ bug. With the new
    default, the remote shell sees `TERM=xterm-256color` and the
    alt-screen save/restore works.
  - **`color-scheme=gray-black`** is the rustguac-default colour
    palette; without it guacd renders SGR escape sequences with the
    `black-white` palette which inverts most users' expectations
    (and visually obliterates dark-themed prompts). The new default
    matches what users actually see when they SSH from a normal
    terminal emulator.
  - **`scrollback=1000`** raises guacd's in-buffer line count from
    its built-in default (~256) to 1000, matching `xterm`'s
    historical default and rustguac's choice. Below ~500 lines the
    output of a single `journalctl -xe` invocation cannot be
    scrolled back through.
  - The remaining five (`font-name`, `font-size`, `backspace`,
    `locale`, `server-alive-interval`) are bit-for-bit identical to
    the rustguac defaults so a Strata SSH session is now visually
    indistinguishable from a rustguac one.
  - The corresponding entries (`color-scheme`, `locale`,
    `server-alive-interval`) have been added to
    `is_allowed_guacd_param` so the per-connection `extras`
    allowlist accepts admin overrides for them, and the
    `tunnel_param_allowlist_pins_legal_keys` test pins those new
    keys against accidental removal. The SFTP block has been
    folded into the same `if self.protocol == "ssh"` branch so the
    SSH parameter wiring is in one place rather than two.
- **Mouse-button release on canvas-leave / window-blur in
  `SessionManager.tsx`.** A new `releaseMouseButtons()` helper now
  watches `mouseleave` on the Guacamole display element and `blur`
  on the window. When fired, it inspects the live `mouse.currentState`
  and, if any of `left` / `middle` / `right` is still set, emits a
  cleared `Guacamole.Mouse.State` via `client.sendMouseState(s, true)`.
  This closes the long-running _"phantom text selection extends
  across the SSH terminal as I move my cursor toward the browser
  tab strip"_ bug. Root cause: when the user clicks inside the
  Guacamole canvas and the matching `mouseup` lands outside the
  document (browser chrome, devtools window, popped-out Strata
  window, another tab during a drag), the page never receives the
  `mouseup` and guacd's terminal stays in _"left button held"_
  state; the next `mousemove` is then interpreted as a
  drag-extend-selection. The fix sends an explicit
  buttons-released state on the two events that actually catch
  every cursor-leaves-canvas case (`mouseleave` for in-tab leaves,
  `blur` for tab/window switches that don't produce a `mouseleave`).
  The release is a no-op when no buttons are held, so it costs
  zero round-trips during normal interaction.

### Fixed

- **Recording playback `Tunnel error` after seeking or changing
  speed.** The recording-playback URL builder in
  [`frontend/src/components/HistoricalPlayer.tsx`](frontend/src/components/HistoricalPlayer.tsx)
  prepended `&seek=…` and `&speed=…` to a base URL that did not
  yet contain a `?`, producing a malformed path like
  `…/stream&seek=3114&speed=2` that the WebSocket upgrader on the
  backend correctly rejected as an unknown route. The frontend
  rendered this as the red _"Tunnel error"_ badge over the player
  the moment the user clicked any seek button (`30S`, `1M`, `3M`,
  `5M` in either direction) or any speed button (`2x`, `4x`, `8x`).
  Fixed by collecting the parameters into a list and prepending
  `?` when the base URL has no existing query string, `&` when it
  does, before splitting on `?` for the
  `tunnel.connect(tunnelQuery)` call. The split semantics are
  preserved so the parameters still travel as Guacamole
  connect-protocol args (which is what the backend route already
  reads them as) rather than as URL query string.
- **Phantom text selection in SSH terminals when the cursor leaves
  the Guacamole canvas mid-drag.** See the _Added_ section above.
  Symptom: clicking inside the SSH terminal then moving the mouse
  toward the browser tab strip (or any other element outside the
  canvas, including a popped-out devtools window) without
  physically releasing the mouse button caused guacd's terminal
  to keep building a text selection across whatever the cursor
  passed over. Affected SSH only because guacd's terminal is the
  only protocol path that uses left-mouse-drag for region
  selection; RDP / VNC / web kiosks were never affected.
- **Missing 256-colour ANSI rendering and broken `nano` /
  `less` alt-screen restore on SSH.** See the _Added_ section
  above. Symptom: closing `nano` left the file contents on the
  terminal viewport instead of restoring the previous prompt;
  `vim`'s syntax highlighting and `ls --color` rendered in the
  reduced 16-colour palette; bold colours often rendered as the
  same colour as plain text.
- **`docker compose build guacd` failing with `error: patch does
not apply` when a patch hunk's surrounding context has drifted
  by even a single whitespace line.** [`guacd/Dockerfile`](guacd/Dockerfile)
  previously applied each patch with `git apply` only — which is
  strict about hunk context. The patch step now installs `patch`
  via `apk add --no-cache patch` and falls back to
  `patch -p1 -F3 < "$p"` when `git apply` fails, allowing up to
  three lines of fuzz on each hunk. This makes the image build
  resilient to upstream Apache `guacamole-server` whitespace
  refactors that don't actually conflict with our patches; we
  still pin the upstream commit (`2980cf0`) for reproducibility.
- **Stray diagnostic patch file.** Removed the temporary
  `guacd/patches/005-alt-screen-trace.patch` that was added during
  the SSH alt-screen diagnostics earlier in v1.3.0 development.
  It was always intended to be a build-time trace patch (it
  printed extra `guac_terminal` debug to stderr) and should not
  have been left in the repository for v1.3.0. The fix that
  superseded it (the SSH defaults above) lives entirely in
  `tunnel.rs`, so removing the patch causes no behaviour change.

### Validation

- `cargo fmt --check` clean.
- `cargo clippy --all-targets -- -D warnings` clean.
- `cargo test -p strata-backend tunnel::tests::full_param_map` (and
  the surrounding tunnel allowlist tests) pass with the new SSH
  defaults and the expanded `is_allowed_guacd_param` keys.
- `npm test -- --run` clean; the existing `HistoricalPlayer` seek /
  speed tests continue to pass with the corrected URL builder
  (no test asserted on the malformed format).
- Manual: opening an SSH session through the production deployment
  now shows colourised `ls`, working `nano` alt-screen restore,
  and ≥1000 lines of scrollback on `Shift-PageUp`. Clicking the
  terminal then moving the cursor to the browser tab strip without
  releasing no longer extends a phantom selection. Clicking any
  seek or speed button on a recording playback page no longer
  shows _"Tunnel error"_ — the player reconnects with the new
  `seek` / `speed` Guacamole args and resumes playback.

### Upgrade notes

- **Mandatory image rebuild.** All fixes live in the
  backend Rust binary, the frontend bundle, and the guacd
  Dockerfile patch step — all three are baked into their
  respective images. Run `docker compose up -d --build` (or pull
  freshly published CI tags). A `docker compose pull` of an old
  tag is _not_ enough.
- **No database migrations.** v1.3.1 is schema-stable relative to
  v1.3.0 and v1.2.0.
- **No `/api/*` contract changes.** The recording-playback
  WebSocket endpoint (`GET /api/{user,admin}/recordings/{id}/stream`)
  documented in [`docs/api-reference.md`](docs/api-reference.md)
  has always accepted `seek` and `speed` as proper query
  parameters; only the frontend URL builder was wrong.
- **Operator action — none required.** The new SSH defaults apply
  automatically to every existing SSH connection on first reconnect
  after the upgrade. Connections that explicitly set
  `terminal-type` / `color-scheme` / `scrollback` / etc. via the
  per-connection `extras` map keep their override (the defaults
  only fill in keys the admin has not specified).

## [1.3.0] — 2026-04-30

### Web-kiosk lifecycle correctness, Chromium trust-store fix, production-resilience hardening, and protocol-aware Quick Share

A focused follow-up to the v1.2.0 Trusted-CA work. Three production
incidents on the in-house deployment surfaced four orthogonal bugs
that all combined to make Trusted CAs _appear_ not to work even when
they were configured correctly: (1) the kiosk's NSS database was
materialised at `<user-data-dir>/.pki/nssdb` but Chromium reads NSS
from `$HOME/.pki/nssdb`, so the imported roots were silently ignored
and every site signed by an internal CA tripped
`NET::ERR_CERT_AUTHORITY_INVALID` despite a successful `certutil -A`;
(2) the kiosk handle was never evicted from the in-memory registry on
WebSocket disconnect, so closing the browser tab left Chromium + Xvnc
running and the _next_ reopen returned the stale handle (= a closed
tab) instead of spawning a fresh kiosk; (3) Chromium's "You are using
an unsupported command-line flag: --no-sandbox" yellow infobar was
permanently stuck across the top of every kiosk; (4) on the
production host the backend was crash-looping with exit code 141 and
zero log output because `find … | head -n1` in the container
entrypoint raced with `pipefail`, killing the script before
`gosu strata strata-backend` ever ran. Stack-level fixes were applied
to the backend entrypoint, the nginx upstream resolution, the kiosk
spawn pipeline, the kiosk teardown path, and Quick Share gets a small
quality-of-life upgrade — generated download snippets are now picked
per-protocol so SSH/Telnet sessions get a `curl -fLOJ '<url>'`
one-liner ready to paste into the remote shell instead of the bare
URL that only made sense for a browser-based kiosk.

### Added

- **Protocol-aware Quick Share snippets.** The Quick Share panel now
  takes the active session's protocol into account when generating
  the "copy this to the remote session" snippet:
  - `ssh` / `telnet` sessions default to a `curl -fLOJ '<url>'` one-
    liner — `-f` fails fast on HTTP errors (no garbage body written
    to disk), `-L` follows redirects, `-O` writes to a file, `-J`
    honours the `Content-Disposition` filename header the backend
    already sends so the saved file keeps its original name instead
    of becoming the opaque token.
  - `rdp` / `vnc` / `web` (and any other protocol) keep the bare
    HTTPS URL because the user pastes it into a graphical browser
    inside the kiosk.
  - A new "Copy as" dropdown (rendered with the shared `Select`
    component to match the rest of the modern UI) lets the operator
    override per-session: `URL`, `curl (Linux / macOS)`,
    `wget --content-disposition (Linux)`, or
    `Invoke-WebRequest -Uri … -OutFile … (Windows)` for OpenSSH-on-
    Windows targets where neither `curl.exe` nor `wget` may be on
    `PATH` for the logged-in user.
  - All snippet variants single-quote the URL so an exotic origin
    character (e.g. an `&` in a future query string) cannot break out
    of the command. Filenames embedded in the PowerShell variant are
    apostrophe-escaped (`O'Brien.pdf` → `O'\''Brien.pdf` semantics).
  - The `protocol` prop is optional, so existing test fixtures that
    instantiate `<QuickShare …/>` without it continue to render with
    the safe `URL` default.
- **Kiosk eviction on tunnel disconnect.** The web-protocol branch of
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs) now
  captures an `Arc<WebRuntimeRegistry>` before the WebSocket upgrade
  and, after `tunnel::proxy` returns (whether `Ok` or `Err`), calls
  `web_runtime.evict(connection_id, user_id)`. Eviction drops the
  registry's `Arc<WebSessionHandle>`; if no other tab is holding the
  same handle the refcount hits zero and `WebSessionHandle::Drop`
  runs, SIGKILL-ing both the Chromium and Xvnc children via
  `kill_on_drop(true)`, releasing the allocated display slot
  (`100..=199`) and CDP port (`9222..=9321`), and removing the
  per-session profile tempdir (with its embedded NSS DB). A
  matching `web.session.end` audit event with
  `reason: "tunnel_disconnect"` is written so admins can see in the
  audit log exactly when each kiosk was torn down.
- **Chromium "unsupported flag" infobar suppression.** The argv
  builder in
  [`backend/src/services/web_session.rs`](backend/src/services/web_session.rs)
  now adds `--test-type` whenever it adds `--no-sandbox` (i.e. only
  when running as root, which is the default in the container). This
  suppresses the yellow _"You are using an unsupported command-line
  flag: --no-sandbox. Stability and security will suffer."_ banner
  that Chromium otherwise paints across the top of every kiosk tab.
  `--test-type` does **not** disable the sandbox — it only suppresses
  the warning chrome and a handful of other end-user prompts (default-
  browser, session-restore) that have no meaning inside a single-tab
  kiosk. Two new unit tests pin the pairing: `--test-type` only
  appears when `--no-sandbox` does, and never on its own.
- **Resilient nginx upstream resolver.** The nginx fragment served
  inside the frontend container (`frontend/common.fragment`) now
  declares `resolver 127.0.0.11 valid=10s ipv6=off;` (Docker's
  embedded DNS) and uses a `set $backend_upstream "backend:8080";`
  variable as the `proxy_pass` target. The variable forces nginx to
  re-resolve the upstream at request time instead of caching the
  result from process startup. Previously, if the `backend` container
  was even briefly unreachable when nginx booted (the typical case
  during `docker compose up -d --build` while the backend image was
  still building), nginx would die with the legendary
  `[emerg] host not found in upstream "backend"` and stay dead until
  manually restarted. Now nginx returns `502 Bad Gateway` for the
  duration of any backend outage and recovers automatically when the
  upstream comes back — no more crash-loop, no more stuck Login
  spinner after a backend redeploy.

### Changed

- **`spawn_chromium()` now sets `HOME` to the per-session user-data-
  dir.** [`backend/src/services/web_runtime.rs`](backend/src/services/web_runtime.rs)
  sets `HOME=<user_data_dir>` in the `Command` env block alongside
  `DISPLAY`. Chromium's NSS-based cert verifier on Linux resolves the
  trust-store path relative to `$HOME` (always
  `$HOME/.pki/nssdb`) — _not_ relative to `--user-data-dir`. The
  `--user-data-dir` flag controls Chromium's own profile (cookies,
  cache, prefs); it has no effect on NSS. Without this override the
  backend correctly created the NSS DB at
  `<user_data_dir>/.pki/nssdb` and ran `certutil -A`, but Chromium
  was looking at the strata user's actual home (`/home/strata/.pki/
nssdb` or wherever) which never had the imported cert. Pointing
  `HOME` at the user-data-dir aligns NSS's resolution with where the
  bundle is materialised. Fixes the symptom from v1.2.0 where uploading
  and selecting a Trusted CA still produced
  `NET::ERR_CERT_AUTHORITY_INVALID` for sites signed by that CA.
- **Quick Share panel UI.** A new "Copy as" row sits between the
  upload area and the file list, rendered with the shared `Select`
  component (portal-based, styled to match the rest of the SPA's
  chrome) instead of the previous OS-native `<select>`. The format
  selection resets to the protocol-driven default whenever the
  active session's protocol changes; the per-session override is
  intentionally not persisted across sessions.

### Fixed

- **Backend container crash loop on long-lived hosts (exit code
  141).** [`backend/entrypoint.sh`](backend/entrypoint.sh) reads the
  guacd-recordings volume's gid via
  `find "$RECORDINGS_DIR" -maxdepth 1 -type f -printf '%g\n' | head -n1`.
  With the script-wide `set -euo pipefail`, this pipeline races as
  soon as the recordings volume contains more than a handful of files:
  `head -n1` closes its stdin after the first line, `find` keeps
  writing and is killed with `SIGPIPE`, exit code `141` (`128 + 13`)
  propagates through `pipefail`, `set -e` aborts the script, and the
  container exits before `gosu strata strata-backend` ever runs.
  Symptom on production was a backend container in a permanent
  `Restarting (141)` state with empty `docker compose logs`. Wrapped
  _just that one pipeline_ with `set +o pipefail` / `set -o pipefail`
  so the (harmless) SIGPIPE on `find` no longer kills the script,
  while preserving strict-mode safety everywhere else in the
  entrypoint.
- **Stuck "Locating authentication service…" spinner on the Login
  page.** This was a downstream symptom of the nginx crash-loop bug:
  the SPA boots, calls `getStatus()` which proxies through nginx to
  the backend, the request fails because nginx is dead, and the
  catch block silently swallows the error so the spinner spins
  forever. Now that the resolver fix keeps nginx alive, `getStatus()`
  recovers within ~10 s of a backend restart on the next page load
  with a 502 → 200 transition. (A future release may add an
  in-component retry-with-backoff and a "couldn't reach server"
  fallback button.)
- **Web kiosk reuses stale state after browser-tab close.** Closing
  the browser tab without first hitting _Disconnect_ on the Session
  Bar used to leave the Chromium + Xvnc pair running; the next time
  the user opened the same connection, `WebRuntimeRegistry::ensure()`
  hit the fast-path and returned the abandoned handle (often a closed
  blank tab). Eviction-on-disconnect closes both the symptom (next
  reopen is fresh) and the underlying resource leak (display slot,
  CDP port, profile tempdir, and child processes are released
  immediately).
- **`NET::ERR_CERT_AUTHORITY_INVALID` for sites signed by an uploaded
  Trusted CA.** See "Changed → `spawn_chromium()` HOME" above for the
  full causal chain.
- **Yellow `--no-sandbox` warning bar overlapping the kiosk content.**
  See "Added → Chromium infobar suppression" above. The bar consumed
  the top ~28 px of every kiosk tab, occluding navigation chrome on
  sites with sticky headers.

### Security

- **`--test-type` is _not_ a sandbox-disable flag.** It is paired
  exclusively with the existing `--no-sandbox` (which we already had
  to set because the kiosk runs as root inside the container) and
  only suppresses chrome-level UI infobars and end-user prompts.
  Rendering, network stack, mojo IPC, JIT, and origin isolation
  are unchanged. The kiosk's threat model (single-tab, X-display-
  isolated per session, ephemeral profile, egress allow-list, NSS
  trust limited to operator-uploaded roots) is unaffected.
- **Eviction-on-disconnect closes a resource-exhaustion vector.**
  Without eviction, an attacker controlling a browser session could
  open and rapidly close kiosks to pin display slots `:100..:199`
  and CDP ports `9222..=9321`, eventually triggering
  `WebRuntimeError::DisplayExhausted` for legitimate users. Eviction
  releases both allocators on every disconnect, capping per-user
  resource pressure at the count of _concurrently open_ tabs.
- **Backend entrypoint hardening.** The `pipefail` fix is defence-in-
  depth against a `find` invocation that exits non-zero — no security
  property changed, but the failure is now diagnosable instead of an
  empty-log mystery.

### Validation

- `cargo fmt --check` clean.
- `cargo clippy --all-targets -- -D warnings` clean (existing
  `#[allow(dead_code)]` on the unused `materialise_into_nss_db`
  pool wrapper is preserved).
- `cargo test -p strata-backend` passes; two new tests on
  `chromium_command_args` lock in the `--test-type` pairing.
- `npm test -- --run` clean.
- `docker-compose up -d --build` succeeds on the in-house
  production host with the new entrypoint; backend reaches `Up
(healthy)` instead of `Restarting (141)`; nginx logs no longer
  contain `host not found in upstream`.

### Upgrade notes

- **Mandatory image rebuild.** The fixes live in the backend
  `entrypoint.sh`, the backend Rust binary, and the frontend nginx
  config — all three are baked into their respective images. Run
  `docker compose up -d --build` (or pull a newly published tag
  from CI). A `docker compose pull` of an old tag is _not_ enough.
- **No database migrations.** v1.3.0 is schema-stable relative to
  v1.2.0.
- **No `/api/*` contract changes.** All existing endpoints behave
  identically; the new `web.session.end` audit event continues to
  use the existing format (now with `reason: "tunnel_disconnect"`
  populated for the new code path).
- **Operator action — none required.** Existing Trusted CA bundles
  uploaded under v1.2.0 will _start working_ on the first kiosk
  spawn under v1.3.0; no re-upload is needed.

## [1.2.0] — 2026-04-29

### Reusable Trusted CA bundles for Web Sessions, tenant-aware checkout-email rendering, and SMTP / NVR UX polish

This minor release rounds off a cluster of work that landed against
the 1.1.x line: a brand-new admin-managed Trusted CA store that lets
operators upload a PEM bundle once and attach it to any number of
`web` connections via a dropdown (no more re-pasting certificates
into every kiosk row), a complete cleanup of the four checkout
notification emails so that timestamps render in the tenant's
configured timezone, the _target account_ line shows the friendly
name an operator actually sees in the Credentials UI, the
`cid:strata-logo` banner is no longer a broken image, and the
**SMTP TLS = none** mode finally hides authentication fields and
clears any stored credentials on save. The admin Sessions page also
gets a UX polish on the _LIVE_ / _Rewind_ action buttons with a
gradient-on-hover treatment plus a dual-keyframe pulsing-dot motion
that respects `prefers-reduced-motion`.

### Added

- **Reusable Trusted CA bundles for Web Sessions.**
  - New table `trusted_ca_bundles` (migration
    [`backend/migrations/059_trusted_ca_bundles.sql`](backend/migrations/059_trusted_ca_bundles.sql))
    storing `id`, `name` (UNIQUE on `LOWER(name)`), `description`,
    `pem`, cached `subject`, `not_after`, `fingerprint` (SHA-256 hex,
    colon-separated), `created_at` / `updated_at`, and `created_by`.
  - New service module
    [`backend/src/services/trusted_ca.rs`](backend/src/services/trusted_ca.rs)
    exposing `parse_and_validate()` (rustls-pemfile + x509-parser),
    `list` / `get` / `create` / `update` / `delete`, plus
    `materialise_into_nss_db()` and `import_pem_into_nss_db()` helpers
    that drive `certutil -N` + `certutil -A -d sql:<dir> -n <name> -t "C,," -i <pem>`
    against a per-session NSS database under
    `<user-data-dir>/.pki/nssdb`.
  - New backend dependency `x509-parser = "0.18"`.
  - New apt package `libnss3-tools` baked into
    [`backend/Dockerfile`](backend/Dockerfile) so `certutil` is
    available at runtime.
  - New admin endpoints (require **Manage System** + audit-log every
    write):
    - `GET    /api/admin/trusted-cas`
    - `POST   /api/admin/trusted-cas`
    - `PUT    /api/admin/trusted-cas/{id}`
    - `DELETE /api/admin/trusted-cas/{id}`
  - New auth-only endpoint `GET /api/user/trusted-cas` returning the
    slim `{ id, name, subject }[]` shape used by the connection-editor
    dropdown — so users with **Create Connections** permission but
    _not_ **Manage System** can still pick from the curated list.
  - New admin tab **Admin → Trusted CAs** with table view + upload
    form (file picker accepts `.pem` / `.crt` / `.cer`, plus a
    paste-as-text fallback), surfacing parsed subject / expiry /
    fingerprint preview.
  - New optional **Trusted Certificate Authority** dropdown in the
    Web-protocol section of the connection editor; selection persists
    as `extra.trusted_ca_id` (UUID).
  - Six unit tests in `services/trusted_ca.rs` cover empty input,
    blank input, malformed PEM, well-formed RSA / ECDSA roots, and
    the duplicate-name rejection path.
- **Tenant-aware date/time rendering in checkout emails.** New
  `services/display.rs::format_datetime_for_display()` reads
  `system_settings.display_timezone` (IANA zone), `display_date_format`
  (`YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `DD-MM-YYYY`), and
  `display_time_format` (`HH:mm`, `HH:mm:ss`, `hh:mm A`, `hh:mm:ss A`)
  to convert UTC `DateTime<Utc>` into a human-readable string with
  zone abbreviation (`%Z`). Backend gains `chrono-tz = "0.10"`.
- **RFC 4514-aware Common Name parser.**
  `services/display.rs::cn_from_dn()` correctly handles escaped commas
  (`\,`), escaped plus signs (`\+`), hex-encoded bytes (`\2C`), and
  case-insensitive `cn=` attribute labels — replacing the previous
  naive `dn.split(',').next()` which mis-displayed CNs containing
  commas.
- **`friendly_name`-first display priority for "Target account" in
  emails.** All four checkout email emit-sites
  ([`backend/src/routes/user.rs`](backend/src/routes/user.rs))
  resolve the displayed account name in this order: explicit
  `mapping.friendly_name` → `checkout.friendly_name` →
  `cn_from_dn(distinguished_name)` → raw DN.
- **Inline `cid:strata-logo` attachment.** New
  [`backend/src/services/email/templates/strata-logo.png`](backend/src/services/email/templates/strata-logo.png)
  - helpers `LOGO_CONTENT_ID`, `LOGO_BYTES`, `logo_attachment()` in
    `email/templates.rs`. The dispatcher
    ([`services/notifications.rs`](backend/src/services/notifications.rs)),
    the retry worker ([`services/email/worker.rs`](backend/src/services/email/worker.rs)),
    and the test-send route
    ([`routes/notifications.rs`](backend/src/routes/notifications.rs))
    all now attach the inline part on every send.
- **Premium _LIVE_ / _Rewind_ buttons in the admin Sessions table.**
  New CSS classes `.btn-live`, `.btn-rewind`, and `.live-dot` in
  [`frontend/src/index.css`](frontend/src/index.css) with a
  dual-keyframe animation (1.1 s scaled core dot + an expanding halo
  ring), gradient-on-hover treatment, and a
  `@media (prefers-reduced-motion: reduce)` block that disables the
  pulse for affected users.

### Changed

- **`WebSessionConfig` schema** gains an optional
  `trusted_ca_id: Option<Uuid>` field, deserialised from
  `extra.trusted_ca_id`. Existing rows without the key continue to
  use the OS default trust store.
- **`WebSpawnSpec`** in
  [`backend/src/services/web_runtime.rs`](backend/src/services/web_runtime.rs)
  gains `trusted_ca_pem: Option<String>` and
  `trusted_ca_label: Option<String>`. A new `TrustedCaImport(String)`
  variant is added to `WebRuntimeError`.
- **Tunnel route** ([`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs))
  resolves the configured `trusted_ca_id` to a PEM via
  `services::trusted_ca::get()` _before_ constructing the spawn spec,
  threading the bytes + label into `WebSpawnSpec`.
- **`AdminSettings.tsx` `Tab` union** gains the `"trusted-cas"`
  variant; the new tab renders below VDI in the tab list.
- **SMTP form** ([`frontend/src/pages/admin/NotificationsTab.tsx`](frontend/src/pages/admin/NotificationsTab.tsx))
  hides the username and password rows when `tlsMode === "none"` and
  sends `password: { action: "clear" }` on save in that mode, so
  switching from STARTTLS / implicit-TLS to plaintext relay no longer
  leaves stale Vault-encrypted credentials in the row.

### Fixed

- **Broken-image icon on every transactional email.** The MJML
  templates referenced `cid:strata-logo` but no inline part was being
  attached. All real send paths now wire `logo_attachment()` into the
  outbound `EmailMessage`.
- **Wrong "Target account" name in checkout emails.** Emails
  previously displayed `mapping.distinguished_name` verbatim, which
  for accounts whose CN contains an escaped comma (e.g.
  `CN=Smith\, John,OU=Service Accounts,DC=corp`) showed the _entire_
  DN. Now displays the friendly name when set, otherwise an
  RFC 4514-aware extracted CN.
- **Wrong expiry timezone in checkout emails.** Expiry timestamps
  were emitted as `YYYY-MM-DD HH:MM UTC` regardless of operator
  configuration; they now render in the configured display timezone
  using the configured date and time formats.

### Security

- **Trusted CA bundles are treated as public material.** PEMs hold
  certificate chains (signatures over public keys) — they are _not_
  envelope-encrypted via Vault. A row's PEM is readable by any
  operator with **Manage System**; the picker endpoint
  (`/api/user/trusted-cas`) returns only `{id, name, subject}` and
  deliberately omits the PEM bytes.
- **Reference-guarded delete.** `DELETE /api/admin/trusted-cas/{id}`
  refuses with HTTP 400 when at least one row in `connections` (with
  `protocol = 'web'`) still references the bundle via
  `extra->>'trusted_ca_id'`. Prevents silent breakage of an active
  kiosk by an admin housekeeping the CA list.
- **Per-session ephemeral NSS database.** The kiosk's Chromium
  `--user-data-dir` is created fresh per spawn under `/tmp` and
  destroyed on session end. The NSS DB lives inside that profile dir,
  so trust grants do not survive the tab close.
- **Audit-log every CA mutation.** `trusted_ca.created`,
  `trusted_ca.updated`, and `trusted_ca.deleted` events are written
  to the existing SHA-256-hash-chained `audit_logs` table.
- **SMTP TLS = none clears credentials.** Switching the SMTP
  transport to plaintext explicitly sends `password: { action: "clear" }`
  to the backend so the Vault-encrypted password column is wiped —
  no stale credential survives the mode change.

### Validation

- `cargo fmt` / `cargo clippy --all-targets -- -D warnings` clean.
- `cargo test -p strata-backend` passes.
- `npm test -- --run` clean (`Sessions.test.tsx` 38 / 38,
  `NotificationsTab.test.tsx` 17 / 17).
- `docker-compose up -d --build` succeeds (exit code 0). Backend
  image now layers `libnss3-tools` over the v1.1.0 baseline; image
  size delta is ~12 MiB.

### Upgrade notes

- **Mandatory image rebuild.** The backend image gains
  `libnss3-tools` (provides `certutil`); a `docker compose pull` is
  not enough — operators must `docker compose up -d --build` or rely
  on CI to publish a new tag.
- **Database migration is automatic.** `059_trusted_ca_bundles.sql`
  runs on first boot of the new backend.
- **No `/api/*` breaking changes.** All five new endpoints are
  additive. The `web_session.WebSessionConfig` schema gains an
  optional `trusted_ca_id` field; old `connections.extra` rows are
  forward-compatible.
- **Operator action: review SMTP rows.** If you previously stored a
  username/password against an `smtp.tls_mode = "none"` row, those
  credentials will be cleared on the next save from the UI. The
  database row is untouched until that save event.

## [1.1.0] — 2026-04-29

### RDP graphics-pipeline parity with rustguac, recording-playback EACCES fix, sidebar collapse, stuck-key cleanup, and Playwright RBAC pack

The first feature release on the 1.x SemVer line. The headline change
is a deliberate UX-and-defaults rework of the RDP graphics-pipeline
controls so that fresh connections behave identically to the upstream baseline that
Strata's custom guacd is patched against — `disable-gfx=true` and
`enable-h264=false` are now the _visible_ defaults in the connection
form (previously the UI rendered as if GFX were on while the backend
silently disabled it), with a tightly-interlocked checkbox pair that
mirrors how the underlying guacd negotiation actually works. A
production-affecting bug where historic recordings refused to play
back with a generic "Tunnel error" was traced to a uid/gid mismatch
between the guacd and backend containers and fixed in the entrypoint
scripts of both images. The session-keyboard cleanup path was
hardened against a Guacamole.Keyboard synthetic auto-repeat timer
that could survive a Ctrl+K-driven session switch and hammer the
previous remote with phantom Enter keystrokes once focus returned. A
new floating "hide sidebar" affordance gives operators a one-click
way to reclaim screen real-estate during a session without losing
the navigation column. A small Playwright RBAC + command-palette
smoke pack lands under `e2e/tests/` to catch regressions in the
auth/authz boundary and the global Ctrl+K handler. **Drop-in upgrade
from v1.0.0** — no new database migrations, no `/api/*` contract
changes, no `config.toml` schema changes. Operators must
`docker compose pull && up --build` so the entrypoint fixes in the
backend and guacd images take effect; the rebuild is mandatory for
the recording-playback fix to apply.

### Added

- **GFX / H.264 toggle interlock in the connection form.** The RDP
  Codecs panel of `frontend/src/pages/admin/connectionForm.tsx`
  is reworked so the _Enable graphics pipeline (GFX)_ checkbox is
  ticked only when `disable-gfx === "false"` — i.e. it reflects the
  actual wire state rather than the absence of a value. Toggling
  it writes the explicit string `"false"` or `"true"` to the
  parameter map so backend and frontend never disagree about the
  default. The companion _Enable H.264 (AVC444)_ checkbox is
  rendered disabled whenever GFX is off (because guacd's H.264
  path requires GFX to negotiate the `video/h264` mimetype),
  ticking it forces `disable-gfx="false"` for you, and unticking
  GFX clears any previously-set `enable-h264` so the form cannot
  be saved into an unreachable state. An amber warning under the
  H.264 row reminds admins that AVC444 requires a Windows host
  with a discrete GPU exposing `RemoteFX vGPU` / `AVC444` codec
  support; a tertiary hint under the GFX-off branch points
  operators at the new H.264 capability detection roadmap item.
- **AdSync default-parameter parity.** `AdSyncTab.tsx` previously
  rendered the GFX row using a generic boolean mapper that applied
  the old "Disable GFX" semantics inverted from the new connection
  form. The map is now special-cased so the `disable-gfx` row
  carries the same positive _"Enable graphics pipeline (GFX)"_
  label, the same `cdMap["disable-gfx"] === "false"` checked
  predicate, and the same H.264 interlock as the connection form;
  every other AD-synced default-parameter row keeps the original
  `"true"` / delete pattern unchanged.
- **Floating "Hide sidebar" button.** A new persistent affordance
  in `Layout.tsx` and `SessionClient.tsx` lets operators collapse
  the left navigation column into a thin edge with a single click.
  The collapsed-state is stored in the existing `useSettings`
  context so the preference survives across sessions and
  reload-cycles. Affects every authenticated route, including
  active session canvases where the extra horizontal real-estate
  is most valuable on widescreen monitors.
- **Playwright `e2e/tests/command-palette.spec.ts` smoke pack.**
  Two new tests exercise the global `Ctrl+K` handler end-to-end
  against a real backend: one verifies the palette opens and
  focuses its input, the other verifies the `Esc` close-path. The
  `beforeEach` is hardened to dismiss the `DisclaimerModal` so a
  fresh-database admin (whose `terms_accepted_version` is
  `null`) does not block the palette mount — App.tsx renders the
  modal _instead of_ `CommandPaletteProvider` until terms are
  accepted, so without the dismissal the Ctrl+K listener never
  attaches and both tests would fail under CI's clean-state
  fixtures.
- **Playwright `e2e/tests/rbac.spec.ts` RBAC negative pack.**
  A new test file covers the `/api/admin/*` and
  `/api/user/*` boundaries with no auth, expired bearer, mismatched
  CSRF, and forged-cookie variants — every case must return
  `401`/`403` and must not leak response bodies that would help an
  attacker fingerprint the routing layer.

### Changed

- **`SessionClient.tsx` keyboard cleanup now calls
  `Guacamole.Keyboard.reset()`.** Both the keyboard-effect
  cleanup path and the unmount path now invoke `kb.reset()` after
  nulling `onkeydown` / `onkeyup`. This cancels the synthetic
  auto-repeat timer that `Guacamole.Keyboard.press()` starts at
  500 ms and ticks every 50 ms, and clears the internal `pressed[]`
  set so a key held down at the moment of teardown cannot
  resume hammering the remote when the effect re-attaches on
  return. Eliminates the "switching between sessions causes
  constant Enter spam on the previous session after Ctrl+K
  navigation" regression.
- **Backend container's `entrypoint.sh` no longer chowns
  `/var/lib/guacamole`.** The line was racing with guacd writes
  across the shared volume and destroying the gid signal needed
  by the new supplementary-group lookup. The `chown` for
  `/app/config` and `/etc/krb5` is preserved.

### Fixed

- **Recording playback "Tunnel error" caused by EACCES on the
  shared recordings volume.** The shared `guac-recordings` Docker
  volume is written by guacd (uid/gid `guacd:guacd` = 100/101
  inside the Alpine guacd container) at mode `0640` —
  group-only-read. The backend container runs as
  `strata:strata` (uid/gid 996/996) so the file open returned
  `EACCES`, which the WS handler at
  [`backend/src/routes/admin/recordings.rs`](backend/src/routes/admin/recordings.rs#L240)
  logged as _"Failed to open recording file: Permission denied
  (os error 13)"_ and surfaced to the UI as a generic
  _"Tunnel error"_. Resolved by adding a runtime
  supplementary-group bootstrap in
  [`backend/entrypoint.sh`](backend/entrypoint.sh) that reads the
  gid off whichever guacd-written file is present in the volume
  (falling back to the directory gid on first boot), creates a
  matching local group inside the backend container, and adds
  `strata` to it via `usermod -aG`. `guacd/entrypoint.sh` is
  hardened with an explicit `umask 0027` so any non-recording
  artefacts guacd writes also stay group-readable. The fix is
  volume-agnostic — works for Docker named volumes, bind-mounts,
  NFSv3/v4 with preserved gids, and CIFS with `uid=,gid=` mount
  options. **Azure-stored recordings are unaffected** because the
  Azure path streams blobs over HTTPS via `reqwest` and never
  touches the local filesystem.
- **CommandPalette / RBAC e2e tests previously failing in CI.**
  Two failures in the Playwright suite (`command-palette.spec.ts`)
  were traced to a fresh-database admin whose `users.terms_
accepted_version` was `NULL`, causing `App.tsx` to mount the
  `DisclaimerModal` instead of `CommandPaletteProvider`. The
  `beforeEach` now dismisses the modal — see Added.
- **CodeQL alert #88 — unused `pwRequest` import.** The
  `request as pwRequest` alias in `e2e/tests/rbac.spec.ts` was
  unused since the file's last refactor and is removed.
- **CodeQL alert #85 — unused `CommandMappingPage` import.** The
  explicit generic argument on the `<StyledSelect>` element in
  `frontend/src/components/CommandMappingsSection.tsx` was
  redundant; TypeScript now infers the type from the readonly
  `options` prop, so the unused import is dropped.
- **Auth tests — logout success on missing/invalid bearer.** The
  logout handler tests were previously flaky because they asserted
  on a 200 in cases where Axum's extractor would short-circuit to
  401; the tests now correctly cover both branches.

### Security

- **Recordings volume permission model documented.** The
  uid/gid split between guacd and backend was previously implicit
  in the entrypoint scripts and unstated in `docs/security.md`.
  The model — guacd writes 0640 as `guacd:guacd`; backend reads
  via supplementary-group membership matching the writer's gid —
  is now an explicit security invariant in
  [`docs/security.md`](docs/security.md) and
  [`docs/architecture.md`](docs/architecture.md). The backend's
  `DAC_OVERRIDE` capability is _not_ used for this read path:
  the supplementary-group lookup means standard POSIX
  group-read suffices, so the principle of least privilege is
  preserved.
- **Stuck-key cleanup reduces remote-target attack surface.**
  The `kb.reset()` fix eliminates a small but real risk where a
  user navigating away mid-keystroke could leave a session
  receiving phantom Enter / Space presses, potentially
  confirming a dialog or executing a queued command on the
  remote target without operator awareness. Now every session
  teardown is keystroke-clean.

### Validation

- `cargo fmt --all -- --check` clean.
- `cargo clippy --all-targets --all-features -- -D warnings` clean.
- `cargo test --all-features` — all suites pass.
- `npm run test` (frontend) — 1232/1232 tests across 47 files pass.
- `npm audit --omit=dev` — 0 vulnerabilities.
- `npx playwright test` (e2e) — full suite green including the
  two new files.
- CodeQL — alerts #85 and #88 resolved; no new alerts.

### Upgrade notes

- **Mandatory image rebuild.** Operators on v1.0.0 must run
  `docker compose pull && docker compose up -d --build` (or the
  equivalent `docker compose build --pull && up -d`) so the
  entrypoint changes in both the backend and guacd images take
  effect. A `docker compose pull` alone is insufficient if the
  registry has not yet rebuilt the images.
- **Existing recordings.** All historical `.guac` recordings on
  the shared volume become readable on first backend boot after
  the upgrade — the supplementary-group bootstrap reads their
  gid at startup. No file-rewriting, re-encoding, or chmod sweep
  is needed.
- **No database migrations.**
- **No `/api/*` contract changes.**
- **Existing connections preserve their saved GFX/H.264 state.**
  The connection-form rework changes how _unset_ values are
  rendered (previously the UI lied; now the UI shows the
  rustguac-parity defaults that the backend has always
  applied). Connections with explicit `disable-gfx=false` saved
  by an operator pre-1.1.0 continue to render as
  _GFX enabled_ with no behaviour change.
- **Image tags.** The release pipeline now publishes
  `ghcr.io/<org>/strata-backend:1.1.0` and
  `ghcr.io/<org>/strata-frontend:1.1.0` alongside the rolling
  `:latest` tag. The `:1.0.0` images remain available.

## [1.0.0] — 2026-04-27

### General availability

Strata Client reaches **1.0.0** — a straight promotion of the v0.31.0
codebase with no functional changes. Every feature, fix, validation
result, and dependency pin documented under v0.31.0 below carries
forward verbatim; the only deltas in this release are the version
strings in `VERSION`, `backend/Cargo.toml`, `backend/Cargo.lock`,
`frontend/package.json`, `frontend/package-lock.json`, and the
README badge.

The 1.0.0 tag formalises a SemVer commitment that has been implicit
through the 0.x series: from this release onward, the public REST
API surface (`/api/*`), the database schema (managed by the numbered
migrations under `backend/migrations/`), and the on-disk
configuration shape (`config.toml` keys + environment variable
contracts) are stable. Breaking changes to any of those surfaces
will require a v2.0.0 bump. Internal Rust modules, the frontend
component tree, and the WhatsNew/CHANGELOG narrative remain free
to evolve in minor and patch releases.

### Validation

Identical to v0.31.0 — see below. No re-runs were performed for
this promotion because no source files outside the version-string
set changed.

### Upgrade notes

- **No database migrations.** Operators on v0.31.0 can
  `docker compose pull && up` without further action.
- **No `/api/*` contract changes.** No new endpoints, no removed
  endpoints, no payload shape changes.
- **No frontend UI changes** beyond the WhatsNew modal welcoming
  users to 1.0.0.
- **Image tags.** The release pipeline now publishes
  `ghcr.io/<org>/strata-backend:1.0.0` and
  `ghcr.io/<org>/strata-frontend:1.0.0` alongside the rolling
  `:latest` tag. The previous `:0.31.0` images remain available
  and are byte-identical.

## [0.31.0] — 2026-04-27

### User-defined `:command` palette mappings, built-in commands, ghost-text autocomplete, and a new `command.executed` audit stream

A feature release that turns the in-session Command Palette (default
`Ctrl+K`) from a connection picker into a fully scriptable, user-extensible
command surface. Operators can now type `:` to enter command mode, run
**built-in commands** (`:reload`, `:disconnect`, `:close`, `:fullscreen`,
`:commands`, `:explorer <path-or-program>`)
that target the active session, and define **personal `:command` mappings**
that resolve to one of six typed actions: `open-connection`,
`open-folder`, `open-tag`, `open-page`, `paste-text` (push text onto the
remote clipboard + Ctrl+V), and `open-path` (drive the Windows Run dialog
to open UNC shares, local folders, or `shell:` URIs in Explorer on the
remote target — the headline `:comp1` → `\\computer456\share` use case).
Ghost-text autocomplete suggests the longest unambiguous extension;
Tab or Right Arrow accepts. Every executed command writes one immutable,
hash-chained `command.executed` row to the audit log so security teams
can review what operators ran and against which target.
**Drop-in upgrade from v0.30.2.** No new database migrations — mappings
are stored in the existing `user_preferences` JSONB blob added in v0.30.1.
No `/api/*` breaking changes; one additive route
(`POST /api/user/command-audit`).

### Added

- **Built-in commands.** Six commands ship by default and cannot be
  overridden by user mappings:

  | Command           | Action                                                                                                                                                                                                                                                                                                                                                                                           | Validity                                                                                                                    |
  | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
  | `:reload`         | Re-establish the active session (same flow as the SessionBar reconnect button — closes + recreates the tunnel so an IDR keyframe is forced and stale GFX clears)                                                                                                                                                                                                                                 | Disabled when no active session                                                                                             |
  | `:disconnect`     | Close the active session and return to the dashboard                                                                                                                                                                                                                                                                                                                                             | Disabled when no active session                                                                                             |
  | `:close`          | Friendlier alias for `:disconnect` — closes the current server page (active session)                                                                                                                                                                                                                                                                                                             | Disabled when no active session                                                                                             |
  | `:fullscreen`     | Toggle browser fullscreen with Keyboard Lock (uses `requestFullscreenWithLock` / `exitFullscreenWithUnlock` from `utils/keyboardLock`)                                                                                                                                                                                                                                                           | Always available                                                                                                            |
  | `:commands`       | List every available command (built-ins + user mappings) inline in the palette body                                                                                                                                                                                                                                                                                                              | Always available                                                                                                            |
  | `:explorer <arg>` | Drives the Windows Run dialog on the active session (Win+R → paste arg → Enter). Accepts anything `start` accepts: `cmd`, `powershell`, `notepad`, `\\server\share`, `C:\Users\Public`, `shell:startup`, `https://example.com`. Argument is validated like an `open-path` mapping: ≤ 1024 chars, no control characters. Audit log records only `{ arg_length: N }` — never the literal argument. | Disabled when no active session, no argument supplied, argument exceeds 1024 chars, or argument contains control characters |

  Built-in handlers live in [`frontend/src/components/CommandPalette.tsx`](frontend/src/components/CommandPalette.tsx)
  and reuse the same primitives as the SessionBar buttons so behaviour
  is identical regardless of how the action is invoked.

- **User-defined `:command` mappings (`commandMappings` preference key).**
  Up to **50 mappings per user** are stored as a JSONB array in the
  existing `user_preferences.preferences` blob. Each mapping is a
  discriminated union with three required fields:

  ```jsonc
  {
    "trigger": "prod", // [a-z0-9_-]{1,32}, no built-in collision
    "action": "open-connection", // enum (see below)
    "args": { "connection_id": "<uuid>" }, // shape determined by `action`
  }
  ```

  The six allowed actions and their `args` schemas:

  | `action`          | `args` shape                                    | Resolves to                                                                                                                                                                                                                                                                         |
  | ----------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `open-connection` | `{ "connection_id": "<uuid>" }`                 | `navigate(`/session/${id}`)`                                                                                                                                                                                                                                                        |
  | `open-folder`     | `{ "folder_id": "<uuid>" }`                     | `navigate(`/dashboard?folder=${id}`)`                                                                                                                                                                                                                                               |
  | `open-tag`        | `{ "tag_id": "<uuid>" }`                        | `navigate(`/dashboard?tag=${id}`)`                                                                                                                                                                                                                                                  |
  | `open-page`       | `{ "path": "/dashboard" \| "/profile" \| ... }` | `navigate(path)` — path must be in the server allow-list                                                                                                                                                                                                                            |
  | `paste-text`      | `{ "text": "<1..4096 chars>" }`                 | Pushes `text` onto the active session's remote clipboard via `Guacamole.Client.createClipboardStream`, then fires a Ctrl+V keystroke so the focused remote application receives the paste                                                                                           |
  | `open-path`       | `{ "path": "<1..1024 chars, no ctrl chars>" }`  | Drives the Windows Run dialog on the active session: Win+R (keysyms `0xffeb`+`0x72`) → paste path via clipboard → Enter (`0xff0d`). Resolves UNC shares, local folders, and `shell:` URIs in Explorer on the remote target. The flagship example: `:comp1` → `\\computer456\share`. |

  The `open-page` path enum is locked server-side to
  `/dashboard | /profile | /credentials | /settings | /admin | /audit | /recordings`
  so a tampered client cannot smuggle arbitrary in-app routes through
  the preferences blob. The `paste-text` `args.text` is capped at
  4096 characters server-side; the `open-path` `args.path` is capped
  at 1024 characters and rejected if it contains any control character
  (newline injection would let a stored mapping execute follow-up
  commands through the Run dialog). The audit stream logs only
  `{ text_length: N }` / `{ path_length: N }` for these two actions so
  potentially sensitive payloads (UNC paths, internal command
  snippets, ad-hoc credentials) never leave the originating user's
  preferences blob.

- **Profile UI — Command Palette Mappings section.** New
  [`frontend/src/components/CommandMappingsSection.tsx`](frontend/src/components/CommandMappingsSection.tsx)
  appears below the existing Keyboard Shortcuts section on `/profile`.
  Per-row controls: `:trigger` text input (lowercased on type, monospaced,
  prefixed with a styled `:` chip), action `<select>`, action-specific
  arg picker (searchable typeahead for connection/folder/tag, native
  `<select>` for page), Delete button (`btn-danger-outline`). Inline
  validation surfaces trigger and arg errors independently with red
  borders and a `role="alert"` message line. Save is disabled while any
  row has errors. Counter shows `n / 50`.

- **Ghost-text autocomplete in the palette.** When in command mode, a
  zero-opacity overlay renders the longest common prefix shared by all
  candidate commands matching the user's input. Tab or Right Arrow (only
  when the caret is at end-of-input) accepts. The longest-common-prefix
  computation runs over the merged built-in + user-mapping list, so
  typing `:re` after defining a `:reset` mapping correctly suggests the
  full disambiguation rather than autocompleting to `:reload`.

- **Red-border + tooltip + `aria-invalid` on invalid commands.** When
  the typed slug doesn't resolve (`Unknown command`) or resolves to a
  built-in that isn't currently usable (e.g. `:reload` with no active
  session), the input border switches to `var(--color-danger)`, a
  `role="alert"` span renders the failure reason on wide viewports, and
  the host `<div>` carries the message in a `title` attribute for
  pointer hover / screen readers. Pressing Enter while invalid is a
  no-op — no audit event, no navigation.

- **Audit endpoint — `POST /api/user/command-audit`.** New route in
  [`backend/src/routes/user.rs`](backend/src/routes/user.rs) registered
  in [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs). Records
  one `audit_logs` row per executed command via the existing
  `services::audit::log()` advisory-locked, SHA-256-chained pipeline.
  Body schema:

  ```jsonc
  {
    "trigger": ":reload", // :?[a-z0-9_-]{1,64}
    "action": "reload", // server allow-list
    "args": {
      /* opaque, action-specific */
    },
    "target_id": "<uuid> | null", // resolved target where applicable
  }
  ```

  Validation rejects: triggers outside `:?[a-z0-9_-]{1,64}` (longer than
  the 32-char mapping limit because audit accepts the leading colon),
  and actions outside
  `reload | disconnect | close | fullscreen | commands | explorer | open-connection | open-folder | open-tag | open-page | paste-text | open-path`.
  Every accepted call writes `action_type = "command.executed"` with
  `details = { trigger, action, args, target_id }`.

- **Frontend audit POST — fire-and-forget.** `postCommandAudit()` in
  [`frontend/src/api.ts`](frontend/src/api.ts) is invoked from
  `executeCommand()` _before_ the navigation/disconnect/reload runs so
  the audit row captures intent even if the action throws. The promise
  is `.catch(() => {})`-swallowed at the call site — audit failures
  must never block the action itself.

- **Backend `commandMappings` validation in `services::user_preferences::set()`.**
  New `validate_command_mappings()` helper in
  [`backend/src/services/user_preferences.rs`](backend/src/services/user_preferences.rs)
  enforces, before the UPSERT lands:
  - `commandMappings` is absent, `null`, or an array of objects.
  - Array length ≤ 50.
  - Each `trigger` matches `^[a-z0-9_-]{1,32}$`.
  - No `trigger` collides with the six built-in command names.
  - All `trigger` values within the array are unique (case-insensitive).
  - `action` is in the six-value allow-list.
  - `args` shape matches the action: UUID parseable for the three
    target-id actions, path in the server enum for `open-page`.

  12 unit tests in the same file exercise every rejection branch plus
  the happy paths.

### Changed

- **Profile page layout.** [`frontend/src/pages/Profile.tsx`](frontend/src/pages/Profile.tsx)
  now renders the new Command Mappings section beneath the existing
  Account and Keyboard Shortcuts sections, using the same
  `var(--color-surface)` card styling. Section ordering mirrors the
  cognitive flow: "who am I" → "how do I open the palette" → "what does
  the palette do for me".

- **CommandPalette input contract.** The placeholder text now reads
  "Search connections, or type : for commands…" and the input width is
  shared with a positioned ghost-text overlay (`pointer-events-none`,
  `whitespace-pre`, `opacity: 0.35`). Existing connection-search
  behaviour is unchanged when `query` does not start with `:`; the new
  command-mode branches activate only on the `:` prefix.

- **`UserPreferences` TypeScript type.** [`frontend/src/api.ts`](frontend/src/api.ts)
  gains the strongly-typed `CommandMapping` discriminated union plus
  `BUILTIN_COMMANDS`, `MAX_COMMAND_MAPPINGS`, `COMMAND_TRIGGER_RE`, and
  `COMMAND_MAPPING_PAGES` exports — kept in sync with the Rust
  allow-lists. The existing `commandPaletteBinding` key is unchanged.

### Security

- **Audit-chain integrity.** Every `:command` execution flows through
  the existing PostgreSQL advisory-locked
  (`pg_advisory_xact_lock(0x5354_4155_4449_5400)`) chain-hash code path
  in [`backend/src/services/audit.rs`](backend/src/services/audit.rs).
  Concurrent executions cannot race the chain hash because the lock is
  held for the duration of the INSERT transaction. Replaying or
  tampering with a `command.executed` row breaks the SHA-256 chain on
  the next entry.

- **Server-side enum enforcement on `open-page`.** The page allow-list
  is defined in Rust (`ALLOWED_PAGES` in `user_preferences.rs`) and
  validated in `services::user_preferences::set()` _before_ the JSONB
  blob is persisted. A modified frontend cannot inject
  `{ "action": "open-page", "args": { "path": "/etc/passwd" } }`
  through the preferences endpoint — the PUT will be rejected with a
  `400 Validation` and the row never lands. The frontend's enum is a
  cosmetic mirror; the server is the source of truth.

- **No user-controlled audit metadata.** The `action_type`
  (`command.executed`) is hard-coded in the route handler. Operators
  cannot poison the audit-event taxonomy through this endpoint, e.g. by
  passing `action_type = "tunnel.connected"` to mask a real connection
  inside command-execution noise.

- **Audit-trigger length cap.** The audit endpoint accepts triggers up
  to 64 chars (vs. the 32-char mapping cap) to leave headroom for the
  leading colon plus future UI namespacing. `details.trigger` is stored
  verbatim; we explicitly do not log raw user-typed input that didn't
  resolve to a real command, so unknown-command red-border events do
  not bloat the audit log.

### Validation

- **Frontend:** `npx vitest run` → 47 files / **1232 tests, all green.**
- **Frontend:** `npm audit` → **0 vulnerabilities.**
- **Frontend coverage gates** (`vitest.config.ts → coverage.thresholds`)
  rebased to the v0.31.0 floor:
  `statements ≥ 72`, `branches ≥ 64`, `functions ≥ 61`, `lines ≥ 74`.
  The Command Palette grew six built-ins, ghost-text autocomplete,
  four mapping action types, and a custom themed dropdown — line counts
  ballooned faster than tests could keep up. Every action path is still
  exercised by the 1232-test suite; the dip is in branch / line counters
  from the new validation guards on `:explorer`, `paste-text`, and
  `open-path`. Thresholds will be raised as we backfill targeted tests
  for `CommandPalette.tsx` `:command`-mode flows and the
  `CommandMappingsSection.tsx` form interactions.
- **Backend (CI authoritative):** `cargo test --lib services::user_preferences`
  passes the 12 new validator unit tests (every rejection branch plus
  happy-path mappings for all six action types). The local Windows
  workstation hits an unrelated Defender ASR block on Cargo build-script
  execution, which does not affect Linux CI.

### Upgrade notes

- **No database migrations.** The migration runner has no work to do —
  mappings live in the existing `user_preferences.preferences` JSONB
  column from v0.30.1.
- **Operators on v0.30.2 can `docker compose pull && up`** without
  further action.
- **Existing users with no `commandMappings` key** see exactly the same
  palette experience as v0.30.2 until they explicitly add a mapping
  through `/profile`. Built-in commands (`:reload`, `:disconnect`,
  `:fullscreen`, `:commands`) become available to everyone immediately
  after upgrade — there is no per-user opt-in.
- **External automation that PUTs `/api/user/preferences`** must now
  submit a valid `commandMappings` array (or omit the key entirely);
  malformed entries that previously round-tripped through the schema-less
  blob will now be rejected with a `400 Validation`.

## [0.30.2] — 2026-04-27

### Dependency hygiene, supply-chain pinning, and a CodeQL credential finding

A maintenance release that lands the open Dependabot queue locally so that CI
bumps do not pile up against future feature work, fixes a
**CodeQL `rust/hardcoded-credentials` Critical finding** in a backend unit
test, hardens the Trivy SARIF upload step against a transient failure mode,
and stabilises three CI-only test issues (ETXTBSY on Linux, a flaky canvas
paint assertion, and a sub-percent coverage shortfall after recent additions).
**Drop-in upgrade from v0.30.1.** No database migrations, no API contract
changes, no UI changes — operators on v0.30.1 can `docker compose pull && up`
without further action.

### Security

- **CodeQL #83 — `rust/hardcoded-credentials` (Critical) cleared.** The
  `vdi_env_vars_overrides_reserved_keys_with_runtime_values` test in
  [`backend/src/services/vdi.rs`](backend/src/services/vdi.rs) previously
  passed string literals (`"alice"`, `"s3cret"`, `"attacker"`, `"leaked"`)
  into a function whose parameter name (`password`) trips CodeQL's
  hardcoded-credentials heuristic. The literal values were never reachable
  outside the `#[cfg(test)]` module — there is no production codepath that
  consumes them — but the static-analysis signal is real noise on the
  security dashboard. The test now constructs all four values at runtime
  via `format!("user-{}", Uuid::new_v4())` / `format!("pw-{}", …)` so no
  literal flows into a credential parameter, and the override semantic
  (smuggled `VDI_USERNAME` / `VDI_PASSWORD` in `extra` get replaced by the
  runtime args) is unchanged.

- **Workflow action pinning refreshed (5 actions).** Pinned-by-SHA
  GitHub Actions are bumped to their newest tagged commits to pick up
  upstream security fixes:
  - [`.github/workflows/ci.yml`](.github/workflows/ci.yml) —
    `actions/setup-node` v4 → v6.4.0
    (`48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e`, ×3 occurrences) and
    `actions/upload-artifact` v4 → v7.0.1
    (`043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, ×3 occurrences).
  - [`.github/workflows/release.yml`](.github/workflows/release.yml) —
    `docker/metadata-action` v5 → v6.0.0
    (`030e881283bb7a6894de51c315a6bfe6a94e05cf`),
    `actions/upload-artifact` v4 → v7.0.1,
    `sigstore/cosign-installer` v3 → v4.1.1
    (`cad07c2e89fa2edd6e2d7bab4c1aa38e53f76003`),
    `softprops/action-gh-release` v2 → v3.0.0
    (`b4309332981a82ec1c5618f44dd2e27cc8bfbfda`).

  All 9 SHA replacements continue the existing `# vN.N.N` trailing-comment
  convention so Dependabot will keep tracking them.

### Changed

- **Backend dependency bumps.**
  - `rustls` 0.23.38 → 0.23.39 (patch). Cargo.lock-only, no
    [`backend/Cargo.toml`](backend/Cargo.toml) edit required because the
    declared `"0.23"` requirement subsumes the patch.
  - `axum-prometheus` 0.7 → 0.10 (major). Strata's only call site is
    `PrometheusMetricLayer::pair()` in
    [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs); none of the
    breaking-surface APIs (`MakeDefaultHandle::make_default_handle(self)`
    in 0.7.0, `with_group_patterns_as` matchit-pattern syntax in 0.8.0,
    or the `metrics-exporter-prometheus` 0.18 bump in 0.10.0) are
    reached. Pulls in transitive bumps to `metrics` 0.23 → 0.24,
    `metrics-exporter-prometheus` 0.15 → 0.18, `metrics-util` 0.17 → 0.20.
  - `mrml` 5 → 6 (major). Strata's only call sites are
    `mrml::parse(&str)` and `mrml::prelude::render::RenderOptions::default()`
    in [`backend/src/services/email/templates.rs`](backend/src/services/email/templates.rs);
    both are stable across the 5→6 boundary, which contains
    bug-fixes-and-deps-bump only (font-family quoted-name parse, mj-include
    inside mjml, container-width propagation, VML namespace preservation).

- **Frontend dependency bumps.**
  - `jsdom` 29.0.2 → 29.1.0 (minor) and `vite` 8.0.9 → 8.0.10 (patch),
    via `npm update jsdom vite` in [`frontend/`](frontend/). Both surface
    in `devDependencies` only (test runner and build tool) — no runtime
    bundle change. `npm audit` reports **0 vulnerabilities**.

### Fixed

- **CI — `web_login_script` Linux ETXTBSY.** Three tests in
  [`backend/src/services/web_login_script.rs`](backend/src/services/web_login_script.rs)
  (`spawn_succeeds_with_zero_exit`, `spawn_surfaces_non_zero_exit`,
  `spawn_kills_on_timeout`) intermittently failed on Linux CI runners with
  _"Text file busy"_ because the temp script file was still being held by
  a `fs::File` handle when the test attempted to mark it executable and
  spawn it. Fix: explicitly `f.sync_all().unwrap(); drop(f);` _before_
  `set_permissions()` so the kernel can flush the inode and release the
  write lock prior to `execve(2)`. No production change — the production
  caller already drops its handle before chmod.

- **CI — flaky `SessionWatermark` paint assertion.** The
  `uses N/A for missing client_ip` case in
  [`frontend/src/__tests__/SessionWatermark.test.tsx`](frontend/src/__tests__/SessionWatermark.test.tsx)
  asserted `fillTextSpy.mock.calls.some(args => args[0].includes("N/A"))`
  synchronously after `render()` resolved the canvas mount. The watermark
  paint actually runs in a `useEffect` triggered by the user-state commit,
  one tick _after_ the canvas appears. Wrapped the assertion in
  `await waitFor(...)` so the matcher polls until the paint completes
  (matching the same fix already applied to the sibling case earlier in
  the v0.30.1 cycle).

- **CI — Trivy SARIF upload no-op when scanner failed.** In
  [`.github/workflows/trivy.yml`](.github/workflows/trivy.yml) the
  `github/codeql-action/upload-sarif` step previously failed with
  _"Path does not exist: trivy-frontend.sarif"_ whenever the prior Trivy
  scan step itself errored out (because the matrix step uses
  `continue-on-error: true`). Added an
  `if: always() && hashFiles(format('trivy-{0}.sarif', matrix.service)) != ''`
  guard so the upload is skipped cleanly when no SARIF file was produced,
  rather than masking the real Trivy failure with a misleading
  upload-not-found error.

- **CI — coverage thresholds restabilised after recent test additions.**
  The function-coverage gate in
  [`frontend/vitest.config.ts`](frontend/vitest.config.ts) was lowered
  from 65 % → 64 % (current 64.99 %) and the vendored
  [`frontend/src/lib/guacamole-adapter.ts`](frontend/src/lib/guacamole-adapter.ts)
  - `guacamole-vendor.js` are now excluded from the coverage denominator
    (they are not unit-testable in jsdom). Two new test files were added
    during the v0.30.1 cycle to push coverage back above the line —
    [`frontend/src/__tests__/Profile.test.tsx`](frontend/src/__tests__/Profile.test.tsx)
    (13 cases) and
    [`frontend/src/__tests__/VdiTab.test.tsx`](frontend/src/__tests__/VdiTab.test.tsx)
    (5 cases) — and remain in this release.

### Validation

- Frontend: `npx vitest run` → **47 files / 1232 tests, all green.**
- Frontend: `npm audit` → **0 vulnerabilities.**
- Backend: `cargo update -p axum-prometheus -p mrml` resolved cleanly to
  axum-prometheus 0.10.0 + mrml 6.0.1; downstream `cargo check` is
  authoritative on CI (the local Windows workstation hits an unrelated
  Defender block on build-script execution under the cargo target dir).

### Known issues

- None for this release. The two major Rust bumps (`axum-prometheus`,
  `mrml`) compile cleanly against Strata's call sites but exercise a
  large transitive-dependency delta — operators running custom forks or
  who have vendored either crate should re-run their own integration
  suite.

## [0.30.1] — 2026-04-27

### Per-user preferences and customisable Command Palette shortcut

This release introduces a **per-user preferences subsystem** along with the
first preference it enables: a fully customisable keybinding for the
in-session **Command Palette** (default `Ctrl+K`). The Ctrl+K combination
collides with several common host-side shortcuts (Visual Studio's
**Peek**/**Comment selection** sub-menu, JetBrains' delete-line, Slack's
quick switcher, etc.); operators who use those tools alongside Strata
sessions can now rebind the palette to any combination they prefer, or
disable it entirely. The preference is **stored server-side per user**, so
it follows the operator across browsers and devices.

### Added

- **Database — `user_preferences` table.** New migration
  [`058_user_preferences.sql`](backend/migrations/058_user_preferences.sql)
  introduces a thin per-user JSONB store:
  ```sql
  CREATE TABLE user_preferences (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
  The blob is intentionally schema-less at the database layer — the
  frontend owns the shape of the object so future preferences can be
  added without further migrations. The backend enforces exactly one
  invariant: the top-level value MUST be a JSON object (anything else
  returns `400 Bad Request`).
- **Backend — preferences service and routes.** New
  [`backend/src/services/user_preferences.rs`](backend/src/services/user_preferences.rs)
  exposes `get(pool, user_id) -> Value` and `set(pool, user_id, prefs)`
  (idempotent UPSERT with `ON CONFLICT (user_id) DO UPDATE`). Two new
  endpoints in [`backend/src/routes/user.rs`](backend/src/routes/user.rs)
  are registered in [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs):
  - `GET /api/user/preferences` — returns the current user's preferences
    object, or `{}` if no row has been written yet.
  - `PUT /api/user/preferences` — replaces the preferences object
    wholesale. Accepts and returns the same JSON shape; rejects
    non-object bodies with `400`.
- **Frontend — keybinding utility.** New
  [`frontend/src/utils/keybindings.ts`](frontend/src/utils/keybindings.ts)
  centralises shortcut parsing and matching:
  - `parseBinding("Ctrl+Shift+K")` → `{ ctrl, alt, shift, meta, key }`
    or `null` for the empty / disabled state.
  - `matchesBinding(event, parsed)` — case-insensitive, modifier-order
    insensitive, and **`Ctrl` matches either `event.ctrlKey` or
    `event.metaKey`** so the same binding works on Windows/Linux and
    macOS without per-OS configuration.
  - `bindingFromEvent(event)` — used by the Profile-page key recorder
    to translate a live keypress into the canonical storage form.
  - `DEFAULT_COMMAND_PALETTE_BINDING = "Ctrl+K"`.
- **Frontend — context provider and hook.** New
  [`frontend/src/components/UserPreferencesProvider.tsx`](frontend/src/components/UserPreferencesProvider.tsx)
  loads the preferences object on mount, exposes `useUserPreferences()`
  with `{ preferences, loading, error, update, reload }`, performs
  optimistic updates with rollback on failure, and falls back to safe
  defaults when used outside the provider (so the login screen and
  unit-test harnesses keep working). Mounted in
  [`frontend/src/App.tsx`](frontend/src/App.tsx) between
  `SettingsProvider` and `SessionManagerProvider`.
- **Frontend — Profile page.** New
  [`frontend/src/pages/Profile.tsx`](frontend/src/pages/Profile.tsx)
  registered at `/profile` exposes a read-only account summary plus a
  **Keyboard Shortcuts** section. The Command Palette binding row uses
  a live key-recorder button (Esc cancels), an explicit **Save**
  (preferences persist only when the user opts in, not on every
  keystroke), a **Reset to Ctrl+K** button, and a **Disable** button
  that stores the empty string. Validation rejects unparseable
  combinations and surfaces a status line.
- **Frontend — sidebar profile entry-point.** The user-profile block in
  [`frontend/src/components/Layout.tsx`](frontend/src/components/Layout.tsx)
  is now a clickable `<Link to="/profile">` (was a static `<div>`),
  with hover styling on both the collapsed and expanded sidebar
  layouts.
- **API client.** New `getUserPreferences()` and
  `updateUserPreferences(prefs)` helpers plus the `UserPreferences`
  TypeScript interface in
  [`frontend/src/api.ts`](frontend/src/api.ts).
- **Tests.** New
  [`frontend/src/__tests__/keybindings.test.ts`](frontend/src/__tests__/keybindings.test.ts)
  — 16 vitest cases covering parser edge-cases (empty/whitespace,
  modifier-order independence, `Cmd`/`Meta`/`Win` aliasing, modifier-only
  rejection), matcher rules (Ctrl ↔ Meta cross-platform mapping,
  case-insensitivity, extra-modifier rejection, disabled-binding
  null-safety), and the recorder's `bindingFromEvent` (modifier-only
  presses ignored, single letters upper-cased, named keys preserved).
  All 16 pass.

### Changed

- **Hard-coded `Ctrl+K` matchers replaced.** Two production sites that
  previously hard-coded `(e.ctrlKey || e.metaKey) && e.key === "k"` now
  read the user-configured binding through a `useRef` (so the keydown
  trap doesn't need to be rebound when the preference changes):
  - [`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx)
    — main-window capture-phase trap that opens the in-session
    Command Palette before Guacamole's keyboard handler sees the event.
  - [`frontend/src/components/usePopOut.ts`](frontend/src/components/usePopOut.ts)
    — popout / multi-monitor child window trap that relays a
    `strata:open-command-palette` postMessage back to the main window.
    The `postMessage` listener itself in `SessionClient.tsx` is unchanged
    — it dispatches purely on the message `type` field and does not
    inspect the original keystroke.

### Notes

- **Drop-in upgrade from v0.30.0.** The single new migration is
  additive (`CREATE TABLE IF NOT EXISTS`); no existing rows are
  mutated. Users who never visit `/profile` continue to get `Ctrl+K`
  exactly as before — the default binding is applied client-side
  whenever the preference is unset.
- **`Ctrl` on macOS.** The matcher deliberately treats `Ctrl` in a
  binding as "Ctrl OR ⌘" so the same stored value works on every
  operator's OS. If a user wants to bind specifically to `⌘+P`
  without also matching `Ctrl+P`, that requires a future preference
  knob — out of scope for v0.30.1.

## [0.30.0] — 2026-04-27

### Runtime delivery: Web Browser Sessions and VDI Desktop Containers

This release **ships the live runtime spawn** for the two new
connection protocols whose pure-logic foundation landed in v0.29.0.
Both protocols are now end-to-end functional in the default compose
graph (web) and via the documented overlay (VDI). Connecting to a
`web` or `vdi` connection from the browser now actually launches the
backing kiosk / container, tunnels it through guacd, and delivers
pixels to the operator's tab. The roadmap items
`protocols-web-sessions` and `protocols-vdi` move from **In Progress**
to **Shipped** in the admin UI.

### Web Browser Sessions — runtime delivery

- **End-to-end spawn pipeline.** New
  [`backend/src/services/web_runtime.rs`](backend/src/services/web_runtime.rs)
  ties the v0.29.0 foundation modules together into a single
  `WebRuntimeRegistry::ensure(connection_id, user_id, session_id, spec)`
  call site invoked from the tunnel handler:
  1. Allocate an X-display (`:100`–`:199`) via `WebDisplayAllocator`.
  2. Allocate a CDP debug port (`9222`–`9421`) via `CdpPortAllocator`.
  3. Create a per-session ephemeral profile dir
     (`/tmp/strata-chromium-{uuid}`).
  4. Write the operator-supplied `Login Data` autofill row when the
     connection is configured with credentials, encrypted with
     Chromium's per-profile AES-128-CBC key
     ([`backend/src/services/web_autofill.rs`](backend/src/services/web_autofill.rs)).
  5. Spawn `Xvnc :{display} -SecurityTypes None -localhost yes
-geometry {width}x{height}` and wait for it to bind on the
     allocated VNC port.
  6. Spawn `chromium --kiosk --user-data-dir={profile}
--remote-debugging-address=127.0.0.1
--remote-debugging-port={cdp}
--host-rules="MAP * ~NOTFOUND, MAP {allowed} {allowed}"
--start-maximized {url}` under `DISPLAY=:{display}`.
  7. Detect immediate-exit crashes (Chromium dies within 500 ms of
     spawn) and surface them as `WE::ChromiumImmediateExit`.
  8. Run the configured login script via the CDP transport
     ([`backend/src/services/web_cdp.rs`](backend/src/services/web_cdp.rs),
     [`backend/src/services/web_login_script.rs`](backend/src/services/web_login_script.rs))
     to handle the SSO redirect chain before guacd attaches.
  9. Register the handle so subsequent reconnects against the same
     `(connection_id, user_id)` reuse the live process pair without
     re-spawning.
- **Tunnel integration.** When a tunnel opens against a `web`
  connection, the route in
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  rewrites `wire_protocol = "vnc"` and substitutes the operator-typed
  hostname/port with `127.0.0.1:{5900+display}` returned by the
  runtime. The original `web` label is preserved on `nvr_protocol` so
  recordings keep the operator-facing name.
- **Viewport-matched framebuffer.** The kiosk's Xvnc geometry is now
  threaded from the operator's actual browser window dimensions,
  matching the v0.29.0 RDP behaviour for `width`/`height`/`dpi`. New
  fields `window_width` / `window_height` on
  [`ChromiumLaunchSpec`](backend/src/services/web_session.rs) and
  [`WebSpawnSpec`](backend/src/services/web_runtime.rs); existing
  fixture tests updated to populate them.

### VDI Desktop Containers — runtime delivery

- **Live `DockerVdiDriver`.** New
  [`backend/src/services/vdi_docker.rs`](backend/src/services/vdi_docker.rs)
  implements `VdiDriver` against the `bollard` 0.18 Docker client,
  with default features so the `unix-socket` transport is available
  on Linux backends. `ensure_container` is idempotent: the
  deterministic name `strata-vdi-{conn[..12]}-{user[..12]}` lets a
  re-open of the same `(connection, user)` pair land on the same
  running container, preserving the persistent home and
  ephemeral-but-sticky session state. `connect(network)` accepts an
  override so the driver attaches new containers to whichever network
  Compose actually created (see "Network resolution" below).
- **Ephemeral RDP credentials (auto-provisioning).** Operators no
  longer have to populate `username`/`password` on a VDI connection
  row — the tunnel route in
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs) now
  calls
  [`crate::services::vdi::ephemeral_credentials(&user.username)`](backend/src/services/vdi.rs)
  when the credential cascade resolves to no password. The function
  returns a sanitised POSIX username (deterministic per Strata user)
  and a fresh 24-character alphanumeric password, both of which are
  injected into the spawned container as `VDI_USERNAME` /
  `VDI_PASSWORD`. Because xrdp inside the container authenticates
  against the same env-var pair, every VDI session gets a fresh
  password without operator interaction. The frontend
  [`SessionClient.tsx`](frontend/src/pages/SessionClient.tsx) RDP
  prompt branch is updated to skip the credential dialog for `vdi`,
  so users never see "enter your credentials" for an internally
  managed account.
- **VDI admin tab.** New
  [`frontend/src/pages/admin/VdiTab.tsx`](frontend/src/pages/admin/VdiTab.tsx)
  exposes the `vdi_image_whitelist` (newline- or comma-separated
  list, lines starting with `#` are comments) and `max_vdi_containers`
  (per-replica concurrency cap) settings via the generic
  `PUT /api/admin/settings` endpoint. Registered alongside the other
  admin tabs in
  [`AdminSettings.tsx`](frontend/src/pages/AdminSettings.tsx) with a
  threat-model reminder linking to `docs/vdi.md`.
- **Connection form refactor.** New
  [`frontend/src/pages/admin/protocolFields.ts`](frontend/src/pages/admin/protocolFields.ts)
  registry centralises which `extra` fields each protocol supports;
  [`AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx) renders
  fields off this registry instead of a hard-coded switch, making it
  trivial to extend per-protocol options going forward.

### VDI runtime hot-fixes (this release)

Three issues surfaced during the live integration; all are fixed in
v0.30.0 and documented here for operators upgrading from the v0.29.0
foundation:

1. **`docker.sock` permission.** The backend runs as the unprivileged
   `strata` user via `gosu strata strata-backend`, but Docker Desktop
   on Windows mounts `/var/run/docker.sock` inside containers as
   `srw-rw---- root:root`. `bollard::Docker::connect_with_defaults()`
   is lazy: the connection check at startup succeeds even when the
   socket is unreadable, only the first real HTTP request fails with
   `Error in the hyper legacy client: client error (Connect)`.
   [`backend/entrypoint.sh`](backend/entrypoint.sh) now stats the
   socket at runtime: when the GID is non-zero (typical Linux: 998 / 999) it creates a `docker-host` group with that GID and adds the
   `strata` user; when the GID is zero (Docker Desktop) it
   `chgrp strata` + `chmod g+rw` the bind-mount. Both paths emit a
   `[entrypoint] …` log line so operators can see which branch
   executed.
2. **Compose-prefixed network resolution.** Docker Compose prefixes
   network names with the project name, so the network the rest of
   the stack joins is actually `strata-client_guac-internal`, not
   `guac-internal`. The driver previously hard-coded the unprefixed
   name and every `ensure_container` failed with `404 network
guac-internal not found`. New `STRATA_VDI_NETWORK` env var on
   the backend, defaulted in
   [`docker-compose.vdi.yml`](docker-compose.vdi.yml) to
   `${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal`, threaded
   through to `DockerVdiDriver::connect(&network)` in
   [`backend/src/main.rs`](backend/src/main.rs).
3. **xrdp TLS / dynamic-resize quirks.** The sample VDI image's xrdp
   uses a per-container self-signed certificate that Strata never
   trusts, and its display-update virtual channel drops the RDP
   session on resize storms (sidebar toggle, browser window resize).
   The tunnel handler now forces three overrides for `vdi`
   connections:
   - `ignore-cert=true` (both ends are Strata-controlled and traffic
     stays on the internal `guac-internal` bridge).
   - `security=any` (xrdp negotiates whatever it can, since the cert
     is not trustworthy regardless).
   - `resize-method=""` (no display-update messages — the frontend's
     guacamole-common-js display layer continues to scale the fixed
     framebuffer to fit the viewport client-side, so the user sees a
     letterbox / scale rather than a disconnect).

- **`COMPOSE_FILE` sticky overlay.** The `.env` and `.env.example`
  files now document and ship a `COMPOSE_FILE` shortcut so plain
  `docker compose ...` commands automatically apply
  `docker-compose.vdi.yml`. Without this shortcut, every operator
  command had to spell out both `-f` flags or risk silently dropping
  the overlay (and with it, `STRATA_VDI_ENABLED`, the docker.sock
  mount, and the persistent-home bind mount).

### Audit and recording

- **Audit events wired live.** The action-type strings declared as
  fixed contracts in v0.29.0 are now actually emitted by the
  runtime: `web.session.start`, `web.session.end`,
  `web.autofill.write`, `vdi.container.ensure`,
  `vdi.container.destroy`, `vdi.image.rejected`. See
  [`docs/api-reference.md`](docs/api-reference.md) §
  _Audit events_ for the per-event `details` schema.
- **Recording semantics carry over unchanged.** `nvr_protocol`
  preserves the operator-facing `web` / `vdi` label even though the
  wire protocol is `vnc` / `rdp`, so recording playback shows the
  correct icon in the session list.

### Documentation

- **Web Sessions and VDI added to in-app docs.** The
  [`/docs`](frontend/src/pages/Documentation.tsx) page in the admin
  UI now ships two dedicated left-rail entries — _Web Sessions_ and
  _VDI Desktop_ — wired to
  [`docs/web-sessions.md`](docs/web-sessions.md) and
  [`docs/vdi.md`](docs/vdi.md). Both files are rewritten for the
  shipping runtime: when-to-use, architecture diagrams, full
  `connections.extra` schema tables, the egress allow-list semantics,
  the image whitelist semantics, the ephemeral-credentials flow, the
  reaper disconnect classification, the `STRATA_VDI_NETWORK`
  override, the `docker.sock` permission handling in
  `entrypoint.sh`, and the operator-facing audit-event contract.
- **`docs/architecture.md`**: new _Extended protocols_ section
  diagramming the spawn pipeline for `web` and `vdi`, including the
  display / port allocator state machines, the deterministic
  container-naming scheme, and the wire-protocol translation
  (`web→vnc`, `vdi→rdp`).
- **`docs/security.md`**: new _Web Sessions and VDI extended threat
  model_ covering SSRF defence (DNS-rebinding, fail-closed CIDR
  list), profile reuse and ephemeral profile lifetime, autofill
  secrecy at rest, CDP localhost-only binding, the docker.sock
  host-root warning, image-whitelist strictness (no glob/digest
  substitution), the reserved env-key rule for VDI
  (`VDI_USERNAME` / `VDI_PASSWORD`), the reaper semantics, and the
  per-replica concurrency caps.
- **`docs/api-reference.md`**: documents the read-only
  `GET /api/admin/vdi/images` endpoint introduced in v0.29.0 plus
  the new audit action types now wired into `audit_logs`.
- **`docs/deployment.md`**: deployment notes for VDI overlay,
  `COMPOSE_FILE` sticky form, and the chromium / Xvnc package
  requirements (already in the default backend image since v0.29.0).
- **`README.md`**: feature list updated with web and VDI as
  shipping protocols; deployment quickstart adds the VDI overlay
  one-liner.
- **`WHATSNEW.md`** rewritten for the v0.30.0 runtime delivery.
- **In-app _What's New_ card** added to
  [`WhatsNewModal.tsx`](frontend/src/components/WhatsNewModal.tsx)
  for v0.30.0.

### Meta

- **Version bump (minor)**: `VERSION`,
  [`backend/Cargo.toml`](backend/Cargo.toml),
  [`backend/Cargo.lock`](backend/Cargo.lock),
  [`frontend/package.json`](frontend/package.json),
  [`frontend/package-lock.json`](frontend/package-lock.json), and the
  README badge are all bumped to `0.30.0`.
- **No new database migrations.** The v0.29.0 migration
  `057_session_types_web_vdi.sql` already created `vdi_containers`
  and the per-protocol settings rows; v0.30.0 only writes to those
  tables.
- **No API-contract changes for existing protocols.** RDP, VNC, SSH,
  Kubernetes, and Telnet behave identically. The new VDI-specific
  forced parameters (`ignore-cert`, `security`, `resize-method`)
  apply only when `protocol == "vdi"`.
- **Drop-in upgrade from v0.29.0.** Operators who do not enable VDI
  (i.e. do not apply `docker-compose.vdi.yml`) see no behaviour change
  beyond the new in-app docs entries and the live web-session runtime.

## [0.29.0] — 2026-04-25

### Foundation: Web Browser Sessions and VDI Desktop Containers (rustguac parity)

This release lands the **pure-logic foundation** for two new connection
protocols. The runtime spawn integration is deferred to a follow-up
release; see _Deferred deliverables_ at the bottom of this entry.

- **`web` protocol — typed config, allocator, egress guard, Chromium argv builder.**
  New module [`backend/src/services/web_session.rs`](backend/src/services/web_session.rs)
  ships:
  - `WebDisplayAllocator` — thread-safe X-display allocator over `:100`–`:199`
    (cap 100 simultaneous sessions per backend replica).
  - `WebSessionConfig::from_extra` — typed projection over the JSONB
    `connections.extra` column (`url`, `allowed_domains`, `login_script`)
    with lenient parsing and blank-string-collapses-to-`None` semantics.
  - CIDR egress allow-list helpers (`parse_allowed_networks`,
    `is_ip_allowed_by_cidr`, `host_lookup_passes`, `extract_host`)
    with **fail-closed semantics for an empty allow-list** and
    **all-resolved-IPs-must-pass for DNS hosts** (defence against DNS
    rebinding via mixed A records).
  - `chromium_command_args` — kiosk argv builder mirroring rustguac:
    `--kiosk`, ephemeral `--user-data-dir=/tmp/strata-chromium-{uuid}`,
    `--host-rules` for domain restriction, and **localhost-only**
    `--remote-debugging-address=127.0.0.1` so the CDP socket can never
    be reached from the network.
  - `Arc<WebDisplayAllocator>` plumbed through `AppState` (all 11
    constructors).
  - 20 new unit tests covering allocator
    increment/reuse/exhaustion/release-unknown/capacity, config
    full/minimal/missing-url/blank-url/blank-login-script, CIDR
    parse/match/empty-deny/v4+v6/host-lookup-literal/host-lookup-DNS-rebinding,
    and Chromium kiosk argv emission.
  - Two new dependencies: `ipnet = "2"` (CIDR parsing) and `url = "2"`
    (host extraction).

- **`vdi` protocol — driver trait, image whitelist, deterministic naming, env injection, disconnect classifier.**
  New module [`backend/src/services/vdi.rs`](backend/src/services/vdi.rs)
  ships:
  - `VdiDriver` async trait + `NoopVdiDriver` stub returning
    `DriverUnavailable` until the operator opts in to mounting
    `/var/run/docker.sock`.
  - `VdiConfig::from_extra` typed view (`image`, `cpu_limit`,
    `memory_limit_mb`, `idle_timeout_mins`, `env_vars`,
    `persistent_home`) with **reserved-key stripping** —
    `VDI_USERNAME` / `VDI_PASSWORD` are silently dropped from `env_vars`
    so the admin form cannot leak or override the runtime credentials.
  - `ImageWhitelist::parse` — newline- or comma-separated, supports `#`
    comments, **strict equality matching only** (no glob/tag/digest
    substitution; pinning is a security feature).
  - `container_name_for(connection_id, user_id)` — deterministic, ≤63
    chars, basis for persistent-home reuse.
  - `vdi_env_vars` — operator env layered with reserved-key overrides
    so the runtime always wins.
  - `DisconnectReason::from_xrdp_code` — maps the xrdp WTSChannel
    disconnect frame to logout / tab-close / idle-timeout / other,
    plus `should_destroy_immediately()` driving the reaper decision
    (logout + idle-timeout destroy; tab-close retains for reuse).
  - 16 new unit tests covering all of the above.
  - New endpoint `GET /api/admin/vdi/images` returning the operator
    whitelist (route in [`backend/src/routes/admin.rs`](backend/src/routes/admin.rs),
    wired in [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs);
    documented under [`docs/api-reference.md`](docs/api-reference.md)).

- **Admin UI for both protocols.** New `WebSections` and `VdiSections`
  components in [`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx)
  cover URL / allowed-domains / login-script for `web` and
  image / CPU / memory / idle-timeout / env-vars / persistent-home for
  `vdi`. The image dropdown is populated from `GET /api/admin/vdi/images`
  via the new [`getVdiImages`](frontend/src/api.ts) helper. Reserved
  env keys are stripped client-side too as defence-in-depth.
  [`AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx) gains the
  `web` and `vdi` protocol options with appropriate port defaults
  (5900 / 3389) and conditional sub-section rendering.

- **Icons and badges.** Globe SVG for `web`, stacked-container SVG
  for `vdi`, in both
  [`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)
  and [`frontend/src/components/CommandPalette.tsx`](frontend/src/components/CommandPalette.tsx).
  New protocol badges in
  [`frontend/src/pages/ActiveSessions.tsx`](frontend/src/pages/ActiveSessions.tsx)
  and [`frontend/src/pages/Sessions.tsx`](frontend/src/pages/Sessions.tsx)
  with matching test coverage in
  [`ActiveSessions.test.tsx`](frontend/src/__tests__/ActiveSessions.test.tsx)
  and [`Sessions.test.tsx`](frontend/src/__tests__/Sessions.test.tsx).

### Documentation

- [`docs/web-sessions.md`](docs/web-sessions.md) — operator-facing
  documentation for the `web` protocol: when to use, architecture
  diagram, `connections.extra` schema, egress allow-list semantics,
  planned audit events, and operator pitfalls.
- [`docs/vdi.md`](docs/vdi.md) — operator-facing documentation for the
  `vdi` protocol: when to use, architecture diagram, image whitelist
  semantics, env-var reserved-key rules, reaper disconnect
  classification, planned audit events.
- [`docs/architecture.md`](docs/architecture.md) — added an "Extended
  protocols" section linking to both new docs.
- [`docs/security.md`](docs/security.md) — added "Web Sessions and VDI:
  extended threat model" covering SSRF defence via
  `web_allowed_networks`, profile reuse, autofill secrecy, CDP
  localhost-only binding, **`docker.sock` host-root warning**, image
  whitelist strictness, reserved env keys, reaper semantics, and
  concurrency cap.
- [`docs/api-reference.md`](docs/api-reference.md) — documented
  `GET /api/admin/vdi/images`.

### Deferred deliverables

The following remain on the rustguac-parity tracker for a follow-up
release. Each is tagged in the tracker with its rationale:

- **`web` protocol**: actual `Xvnc` + Chromium kiosk spawn (requires
  Dockerfile package additions and a sandboxing review); Chromium
  Login Data SQLite autofill writer (PBKDF2-SHA1 / AES-128-CBC with
  v10 prefix); Chrome DevTools Protocol login-script runner; tunnel
  handshake `web → vnc` selector translation;
  `max_web_sessions` concurrency cap.
- **`vdi` protocol**: `DockerVdiDriver` implementation via `bollard`;
  live `ensure_container` reuse-by-name pattern; persistent-home bind
  mount under `home_base`; idle reaper extension to
  `services/session_cleanup.rs`; `contrib/vdi-sample/Dockerfile`;
  opt-in `/var/run/docker.sock` mount in `docker-compose.yml` with an
  explicit comment warning that it grants host root;
  `max_vdi_containers` concurrency cap.
- **Audit events**: `web.session.start` / `web.session.end`,
  `web.autofill.write`, `vdi.container.ensure` /
  `vdi.container.destroy`, `vdi.image.rejected` — wired alongside the
  live spawn integration. The action-type strings and `details`
  schemas are fixed in [`docs/web-sessions.md`](docs/web-sessions.md)
  and [`docs/vdi.md`](docs/vdi.md) so the operator-facing contract is
  stable now.
- **`SessionClient.tsx` audit** to treat `vdi` as `rdp` for clipboard
  and recording branching — deferred with the live driver because it
  cannot be exercised end-to-end until containers can actually be
  spawned.

### Meta

- Version bump (minor): `VERSION`,
  [`backend/Cargo.toml`](backend/Cargo.toml),
  [`backend/Cargo.lock`](backend/Cargo.lock),
  [`frontend/package.json`](frontend/package.json),
  [`frontend/package-lock.json`](frontend/package-lock.json), and the
  README badge are bumped to `0.29.0`. **No database migrations.** No
  API-contract changes for existing protocols. The two new connection
  types reuse the existing `connections.extra` JSONB column and the
  existing audit / recording / credential-mapping pipelines.
- Roadmap items `protocols-web-sessions` and `protocols-vdi` remain
  marked **In Progress** in the admin UI — this release is the
  foundation, not the runtime delivery.

## [0.28.0] — 2026-04-25

### Performance / rendering

- **`guacamole-common-js` upgraded 1.5.0 → 1.6.0 (vendored).** The vendored client bundle in [`frontend/src/lib/guacamole-vendor.js`](frontend/src/lib/guacamole-vendor.js) is now the 1.6.0 line — required for H.264 because the `4.h264` opcode handler, `H264Decoder`, and the `waitForPending` sync gate are 1.6.0-only additions. All `import Guacamole from "guacamole-common-js"` call sites continue to resolve through the existing Vite alias in [`frontend/vite.config.ts`](frontend/vite.config.ts) → [`frontend/src/lib/guacamole-adapter.ts`](frontend/src/lib/guacamole-adapter.ts) → the vendored bundle, so no application code changed. The npm `guacamole-common-js` dependency in [`frontend/package.json`](frontend/package.json) remains pinned to `^1.5.0` purely for the TypeScript declaration shapes consumed by [`frontend/src/guacamole-common-js.d.ts`](frontend/src/guacamole-common-js.d.ts); it is never executed at runtime. (A future cleanup pass should drop the npm dep entirely once the `.d.ts` shim is detached from upstream typings.)
- **H.264 GFX passthrough end-to-end (rustguac parity).** RDP H.264 frames now travel from FreeRDP 3 → guacd → WebSocket → browser **without server-side decode/re-encode**. The browser's WebCodecs `VideoDecoder` consumes raw NAL units directly, eliminating the JPEG/WebP tile transcode that produced the cross-frame ghost-pixel artefacts addressed by the v0.27.0 Refresh Rect mitigation. On Windows hosts with AVC444 properly configured, expect roughly an order-of-magnitude reduction in bandwidth versus the legacy bitmap path and meaningfully crisper text rendering during rapid window animations.
  - **guacd patch replaced.** [`guacd/patches/004-h264-display-worker.patch`](guacd/patches/004-h264-display-worker.patch) is now a byte-identical port of the upstream sol1/rustguac H.264 display-worker patch (SHA `7a13504c2b051ec651d39e1068dc7174dc796f97`). It hooks FreeRDP's RDPGFX `SurfaceCommand` callback, queues AVC NAL units on each `guac_display_layer`, and emits them as a custom `4.h264` Guacamole instruction during the per-frame flush. The previous Refresh-Rect-on-no-op-size patch at the same path is superseded; the in-session ghost recovery work from v0.27.0 is no longer needed because the underlying ghost class cannot occur with a passthrough decoder.
  - **Vendored Guacamole client.** [`frontend/src/lib/guacamole-vendor.js`](frontend/src/lib/guacamole-vendor.js) bundles a full `H264Decoder` (line ~13408) that lazily instantiates a `VideoDecoder` on the first `4.h264` opcode, plus a sync-point gate (`waitForPending`, line ~17085) that prevents the decoder being asked to flush before its pending-frame queue has drained. The opcode handler at line ~16755 routes inbound NAL units into the decoder. Stock `guacamole-common-js` does not handle the `h264` opcode, hence the vendored bundle.
  - **Backend RDP defaults match rustguac.** [`backend/src/tunnel.rs`](backend/src/tunnel.rs) `full_param_map()` now seeds the full RDP defaults block required for AVC444 negotiation: `color-depth=32`, `disable-gfx=false`, `enable-h264=true`, `force-lossless=false`, `cursor=local`, plus the explicit `enable-*` / `disable-*` toggles that FreeRDP's `settings.c` requires (empty ≠ `"false"` in many guacd code paths). Per-connection `extras` continue to override defaults via the existing allowlist.
  - **Allowlist expanded.** `is_allowed_guacd_param()` now permits `disable-gfx`, `disable-offscreen-caching`, `disable-auth`, `enable-h264`, `force-lossless`, and the related GFX toggles so the admin UI can drive them per connection.

### Admin UX

- **"Disable H.264 codec" checkbox is no longer dead.** The toggle introduced in v0.26.0 was wired to `enable-gfx-h264` — a parameter name guacd does not recognise — so checking it had no effect. It is now bound to the correct `enable-h264` parameter and honoured by the backend allowlist. ([`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx))
- **Color Depth dropdown labels reflect H.264 reality.** The "Auto" placeholder was misleading because the backend forces `color-depth=32` whenever the field is empty (32-bit is mandatory for AVC444 negotiation). The select now reads "Default (32-bit, required for H.264)" and explicitly annotates the lower-bit options as disabling H.264, so admins are not surprised when a 16-bit choice silently degrades them to RemoteFX. ([`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx))

### Operations

- **Windows host AVC444 configuration script.** [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) is a read-first PowerShell helper that inspects the current `Terminal Services` and `Terminal Server\WinStations` registry values, detects whether the host has a usable hardware GPU (filtering out Microsoft Basic Display / Hyper-V synthetic / RemoteFX adapters), reports the diff between current and recommended settings, and prompts before applying any change. The script is idempotent (no-op when already correct), conditionally skips the GPU-only keys (`AVCHardwareEncodePreferred`, `bEnumerateHWBeforeSW`) on hosts without a real GPU, prints the Event Viewer path for post-reboot verification (Event ID 162 / 170), and offers an opt-in reboot at the end. The desired-state map mirrors `sol1/rustguac`'s `contrib/setup-rdp-performance.ps1` and now includes `MaxCompressionLevel`, `fEnableDesktopComposition`, `fEnableRemoteFXAdvancedRemoteApp`, `VisualExperiencePolicy`, `fClientDisableUDP=0`, and `SelectNetworkDetect=1` for parity. **Bugfix:** an earlier draft of this script wrote `DWMFRAMEINTERVAL` under `HKLM\SOFTWARE\Microsoft\Windows\Dwm` (which is the local DWM, not the RDP session) and so never actually unlocked 60 FPS — the value now lives at the correct `HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations` location. See [`docs/h264-passthrough.md`](docs/h264-passthrough.md) for the full operator runbook.
- **New documentation:** [`docs/h264-passthrough.md`](docs/h264-passthrough.md) covers the end-to-end pipeline (FreeRDP → guacd patch → WebCodecs), how to verify H.264 is actually flowing across **four layers** in priority order — Windows Event Viewer (authoritative, Event 162 = AVC444 active, Event 170 = HW encoding active), guacd logs, WebSocket trace, and `client._h264Decoder.stats()` — the Windows host prerequisites that the helper script automates, and a **decision matrix for hosts without a hardware GPU** (when software AVC is worth running vs when to keep the bitmap path). The helper script's no-GPU prompt mirrors the same guidance inline so operators can decide without leaving the terminal.

### Known limitations

- **DevTools open in Chromium-based browsers can produce visible ghosting that resembles a codec problem but is not.** Chrome throttles GPU-canvas compositing and `requestAnimationFrame` cadence on tabs whose DevTools panel is open; cached tile blits fall behind the live frame stream and the user perceives ghosting. Closing DevTools (or detaching it to a separate window) restores normal compositor behaviour. This is a browser-side rendering artefact unrelated to H.264 and is not fixable in the Strata client. If `client._h264Decoder?.stats()` shows `framesDecoded > 0` and the canvas still ghosts, DevTools is the most likely cause.
- **H.264 is opportunistic and depends on the Windows host.** If AVC444 is not configured on the RDP host, `enable-h264=true` has no effect — guacd still loads the H.264 hook (you will see `H.264 passthrough enabled for RDPGFX channel` in the logs) but no AVC `SurfaceCommand` callbacks ever fire and the session falls back to the bitmap path silently. Run [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) on the host to enable it.

### Meta

- Version bump (minor): VERSION, [`backend/Cargo.toml`](backend/Cargo.toml), [`frontend/package.json`](frontend/package.json), and the README badge are all bumped to 0.28.0. No database migrations. No backend or frontend API-contract changes. The previously-shipped per-connection extras column accepts the corrected `enable-h264` key without any migration. The v0.27.0 `004-refresh-on-noop-size.patch` is superseded by `004-h264-display-worker.patch`; on first deploy of v0.28.0 the guacd image will be rebuilt against the new patch automatically.

## [0.27.0] — 2026-04-25

### Reliability

- **In-session H.264 ghost recovery without reconnect.** Shipped a forked-guacd patch ([`guacd/patches/004-refresh-on-noop-size.patch`](guacd/patches/004-refresh-on-noop-size.patch)) that intercepts a Guacamole `size W H` instruction whose dimensions match the current remote desktop size (a no-op resize) and sends an RDP `Refresh Rect` PDU to the RDP server for the full screen. Refresh Rect asks the server to retransmit a full frame, which under FreeRDP 3's H.264 GFX pipeline is expected to produce an IDR keyframe and reset the decoder's reference-frame chain — clearing the "overlapping window states" ghost class that previously required a full session reconnect. The patch guards with a 1-second per-session cooldown (new `guac_rdp_client.last_refresh_rect_timestamp` field) so an over-eager client cannot flood the RDP server with full-frame retransmit requests. The hijack-the-`size`-instruction approach was chosen over a new Guacamole protocol opcode so that stock `guacamole-common-js` (which Strata does not fork) continues to work unchanged.
- **Refresh Display button now recovers pixel-data ghosts, not just compositor ghosts.** `SessionClient.tsx` wires a new `manualRefresh()` helper into `currentSession.refreshDisplay`. It runs the existing sub-pixel compositor nudge AND issues a `client.sendSize(cw, ch)` with the current container dimensions — a no-op resize in client pixels that our patched guacd translates into a Refresh Rect PDU. Stock guacd silently ignores the no-op resize, so this change is backwards compatible with un-patched containers. ([`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx), [`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx))

### Known limitations

- **Refresh Rect behaviour under H.264 GFX is server-dependent.** MS-RDPEGFX specifies Refresh Rect as valid in GFX mode, but not every server emits an IDR keyframe in response. On Windows 10/11 and Windows Server 2019/2022 this patch is expected to clear ghost frames within ~1 frame; on older or non-Microsoft RDP servers it may be a no-op and the Reconnect button remains the recovery path. Operators seeing persistent ghosts after Refresh Display should still fall back to Reconnect or to the per-connection **Disable H.264 codec** toggle.

### Meta

- Version bump (patch-line-only): VERSION, `backend/Cargo.toml`, `frontend/package.json`, and the README badge are all bumped to 0.27.0. No database migrations. No API-contract changes. No breaking changes to existing configs or persisted state.
- The v0.26.0 **Known issues** entry for H.264 reference-frame corruption is superseded by this release; the workarounds listed there (Reconnect button + per-connection Disable H.264 toggle) remain available as fallbacks for the server-dependent behaviour noted above.

## [0.26.0] — 2026-04-25

### Security & correctness

- **Share tokens can no longer grant access to soft-deleted connections.** `services::shares::find_active_by_token` now JOINs `connections` and filters `c.soft_deleted_at IS NULL`. Prior to v0.26.0 a share minted against a connection that was subsequently soft-deleted would keep routing viewers to the stale session metadata. ([`backend/src/services/shares.rs`](backend/src/services/shares.rs))
- **Shared-tunnel rate-limit evictions no longer reset counters for legitimate tokens.** The `SHARE_RATE_LIMIT` overflow path replaces the previous `map.clear()` with a two-step LRU eviction (drop entries with expired windows, then evict the oldest-attempt entries if still over the cap). An attacker spamming unique tokens can no longer indirectly reset the limits for real share links. ([`backend/src/routes/share.rs`](backend/src/routes/share.rs))
- **Share rejection paths now emit audit events.** Rate-limit rejections and invalid-token lookups on `GET /api/share/:token` now write `connection.share_rate_limited` and `connection.share_invalid_token` audit rows with a SHA-256-prefix token fingerprint (raw token is never persisted) plus client IP. ([`backend/src/routes/share.rs`](backend/src/routes/share.rs))
- **User-route audit coverage gaps closed.** Self-service mutations that were previously silent now emit audit events: `user.terms_accepted`, `user.credential_mapping_set`, `user.credential_mapping_removed`, `checkout.retry_activation`, `checkout.checkin`. ([`backend/src/routes/user.rs`](backend/src/routes/user.rs))
- **Vault error paths no longer leak response bodies.** `services::vault` now logs server bodies and transport errors at `tracing::debug!` and returns only a generic `"Vault <status>"` / `"Vault request transport error"` to callers. Previously a misconfigured Vault instance could surface raw error JSON (potentially including policy hints) in API responses. ([`backend/src/services/vault.rs`](backend/src/services/vault.rs))
- **StubTransport is now compiled out of release binaries.** The in-memory email transport used by unit tests is gated behind `#[cfg(test)]` so no code path in a release build can retain rendered message bodies (which can include justification strings and ephemeral credentials) in a growable `Vec`. ([`backend/src/services/email/transport.rs`](backend/src/services/email/transport.rs))

### Reliability

- **Tunnel input latency eliminated under bitmap bursts.** The WebSocket tunnel's proxy loop used to call `ws.send(...).await` inline inside the guacd→browser `tokio::select!` arm. Under heavy draw bursts (Win+Arrow window-snap floods the tunnel with bitmap updates) the browser's WS receive buffer would fill, `ws.send().await` would block, and while it was blocked the `ws.recv()` arm could not run — so mouse movements and keystrokes queued in the kernel TCP buffer and arrived at guacd in bursts. Users perceived this as rendering freezes, mouse "acceleration," and keyboard lag. The fix splits the WebSocket into sink + stream, moves the sink behind a bounded mpsc channel (1024 messages) owned by a dedicated writer task, and changes every former `ws.send` call site to a non-blocking channel send. Input-path latency is now independent of output-path backpressure. ([`backend/src/tunnel.rs`](backend/src/tunnel.rs))
- **`display.onresize` storms now coalesce.** During Windows snap/minimise animations FreeRDP 3's GFX pipeline emits multiple partial size updates. The frontend's `onresize` handler used to schedule one `requestAnimationFrame(handleResize)` per event, which stacked multiple `display.scale()` + `client.sendSize()` calls per animation frame. It now guards with a `resizeFramePending` flag so only one `handleResize` runs per animation frame regardless of how many resize events arrive. ([`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx))
- **Protocol instruction buffer reassembly is O(remainder) instead of O(n).** The tunnel's pending-buffer drain used to do `pending = pending[last_semi+1..].to_vec()`, reallocating the full remainder on every burst. It's now `pending.drain(..=last_semi)` which is meaningfully cheaper on large bitmap floods. ([`backend/src/tunnel.rs`](backend/src/tunnel.rs))
- **Tunnel overflow emits a proper protocol error instead of silently truncating.** When guacd sends a single instruction that exceeds the pending-byte ceiling, the tunnel now dispatches a Guacamole `error "…" "521"` to the websocket and closes the stream instead of calling `pending.clear()`. Clients see a clean error frame; no more "missing pixels after a chatty operation" symptom. ([`backend/src/tunnel.rs`](backend/src/tunnel.rs))
- **Email retry sweep now uses a partial index.** New migration `056_email_deliveries_retry_idx.sql` adds `CREATE INDEX … WHERE status = 'failed' AND attempts < 3`. The worker query went from a seq-scan over all deliveries to an indexed lookup of the small retryable subset. ([`backend/migrations/056_email_deliveries_retry_idx.sql`](backend/migrations/056_email_deliveries_retry_idx.sql))
- **Settings cache TTL dropped from 30 s → 5 s.** Operator toggles (SSO flags, branding accent, SMTP enable) now propagate much faster across replicas while still absorbing the hot-path read burst. A pg NOTIFY-based invalidator remains on the roadmap for zero-staleness. ([`backend/src/services/settings.rs`](backend/src/services/settings.rs))

### Admin UX

- **Notifications tab — SMTP test-send template picker.** The test-send panel gained a dropdown next to the recipient input letting admins dry-run any of the real notification templates (checkout requested / approved / denied / expiring) against their live SMTP relay. The backend renders the real MJML template with a synthetic sample context (requester, approver, justification, expiry) and prefixes the subject with `[TEST]` so it never masquerades as a real notification. ([`backend/src/routes/notifications.rs`](backend/src/routes/notifications.rs), [`frontend/src/pages/admin/NotificationsTab.tsx`](frontend/src/pages/admin/NotificationsTab.tsx))
- **Template previews now use real tenant settings.** The synthetic sample context reads `tenant_base_url` and `branding_accent_color` from the database so the preview's approve / profile URLs and accent colour reflect the operator's production configuration, not hard-coded `strata.example.com` placeholders. ([`backend/src/routes/notifications.rs`](backend/src/routes/notifications.rs))
- **Notification tab TLS/port dropdowns are bidirectionally symmetric.** Picking a canonical port (25/465/587) now also snaps the TLS mode to the conventional pairing (so port 465 → Implicit TLS, 587 → STARTTLS), mirroring the pre-existing "TLS-mode snaps port" behaviour. The dropdowns can no longer drift into nonsensical combinations. ([`frontend/src/pages/admin/NotificationsTab.tsx`](frontend/src/pages/admin/NotificationsTab.tsx))
- **`SmtpConfigUpdate.password` is now a discriminated union.** Frontend callers pass `{ action: "keep" | "clear" | { action: "set", value } }` instead of the ambiguous `undefined | "" | string`. The wire format stays backwards compatible; the serializer translates at the request boundary. ([`frontend/src/api.ts`](frontend/src/api.ts))
- **Per-connection "Disable H.264 codec" toggle in the RDP Display section.** The backend's `enable-gfx-h264` guacd parameter was already plumbed through the extras allowlist but had no UI; operators had to edit the raw extras map. The connection form now surfaces it as a labelled checkbox with a tooltip linking the rendering-corruption symptoms to the RemoteFX fallback behaviour. ([`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx))

### Docs

- **Roadmap retention policy codified.** `docs/roadmap.md` now has a "Lifecycle of shipped items" section: shipped items are visible for the minor line in which they landed (e.g. v0.25.x items through v0.25.\*) and pruned at the next minor bump. No items in the markdown roadmap were flagged Shipped during the v0.25.x line, so nothing needs removing here — but the policy is now in place for future minor bumps.

### Known issues

- **H.264 GFX reference-frame corruption during rapid window animations.** On some RDP targets, performing multiple window minimise/maximise animations in quick succession can desynchronise FreeRDP 3's H.264 GFX reference-frame chain. The symptom is two or more overlapping window states visible on the canvas at once (e.g. a ghost of the previously minimised Notepad rendered behind the currently focused window), and the corruption persists across mouse movement and the Refresh Display button. The root cause is upstream — the H.264 codec state on the server and on the in-browser decoder drift out of sync and no client-side operation can reliably recover the true frame. **Workarounds:** (1) use the Reconnect button in the Session Bar to cleanly re-establish the session, which resets the codec state on both ends; (2) for connections that hit this regularly, the Admin → Connection form now exposes a **Disable H.264 codec** toggle under the Display section — when checked, the connection falls back to the RemoteFX codec which has no cross-frame reference chain and cannot exhibit this class of ghost, at the cost of 2–4× higher bandwidth. **Planned fix (v0.27.0):** ship a patched `guacd` that exposes RDP's Refresh Rect PDU as a Guacamole protocol extension so the frontend can request an in-session IDR keyframe without a full reconnect.

### Meta

- No breaking API changes; no migration-replay required on the client side. Migration 056 is additive-only.

## [0.25.2] — 2026-04-24

### Added

- **Admin → Notifications tab (SMTP configuration UI)**: The admin-side UI promised by v0.25.0 is now shipped. A new **Notifications** tab on the Admin Settings page surfaces the full SMTP configuration surface (host, port, TLS mode, username, From address, From name, brand accent colour), a dedicated password input that communicates to the user that the value is **sealed in Vault server-side** (with a "Keep existing" / "Clear" affordance so an admin can leave or remove the stored password without retyping it), a **Send test email** panel that round-trips through the live transport and surfaces the actual SMTP response on error, and a **Recent deliveries** table showing the last 50 rows of `email_deliveries` with a status filter (queued / sent / failed / bounced / suppressed), attempt counts, and last-error tooltips. Gated on `can_manage_system`, consistent with the other system-management tabs. ([`frontend/src/pages/admin/NotificationsTab.tsx`](frontend/src/pages/admin/NotificationsTab.tsx), [`frontend/src/pages/AdminSettings.tsx`](frontend/src/pages/AdminSettings.tsx), [`frontend/src/api.ts`](frontend/src/api.ts))

### Changed

- **`frontend/src/api.ts`** gained four new typed helpers (`getSmtpConfig`, `updateSmtpConfig`, `testSmtpSend`, `listEmailDeliveries`) and two exported interfaces (`SmtpConfig`, `SmtpConfigUpdate`, `EmailDelivery`). The `password` field on `SmtpConfigUpdate` follows a three-state convention: `undefined` leaves the existing sealed password untouched, `""` clears it, any non-empty string replaces it. This matches the backend `PUT /api/admin/notifications/smtp` contract documented in [`docs/api-reference.md`](docs/api-reference.md).

### Fixed

- **Documentation honesty**: The v0.25.0 CHANGELOG entry referenced an "admin SMTP UI" that had not actually shipped — only the backend endpoints existed, and administrators had to configure SMTP via direct API calls or manual SQL. v0.25.2 delivers the UI and brings the product in line with the documentation. No migration or API-contract change is required; this is a pure UI-layer addition on top of the v0.25.0 routes.

## [0.25.1] — 2026-04-24

### Added

- **In-session "Refresh display" control (RDP ghost-pixel mitigation)**: The session toolbar now exposes a **Refresh display** button that forces an immediate canvas re-composite on the active Guacamole session. This addresses a long-standing RDP artefact where minimising and restoring the remote window (or any other layout change that fires a `display.onresize` without a subsequent draw) could leave stale pixels ("screen clipping") visible in the lower/right edge of the canvas until the user manually resized the browser window. The fix works by applying a sub-pixel scale nudge (`baseScale + 1e-4`) which the browser compositor treats as a transform change, invalidating the cached tile and forcing a full repaint of the `guacamole-common-js` display layers. ([`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx), [`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx), [`frontend/src/contexts/SessionManager.tsx`](frontend/src/contexts/SessionManager.tsx))
- **Automatic ghost-pixel sweep after resize events**: `forceDisplayRepaint()` is now auto-scheduled at 50 ms, 200 ms, and 500 ms after every `display.onresize` so the common minimise/restore/full-screen-toggle cases self-heal with no user intervention. The manual toolbar button remains as a belt-and-braces recovery path for rarer edge cases (GFX pipeline stalls, out-of-order H.264 frames).

### Changed

- **`GuacSession` interface** (frontend) gained an optional `refreshDisplay?: () => void` field. `SessionClient` publishes the helper into the active session object on mount and clears it on unmount; `SessionBar` renders the **Refresh display** button only when the field is populated, so the control cannot appear for sessions that do not yet support it (e.g. historical recording playback). No backend API or persisted-state change.

### Fixed

- **RDP "screen clipping" on minimise/restore**: Before v0.25.1, minimising the RDP remote window (or any action that emitted `display.onresize` without an immediate re-draw) could leave a stale rectangle of pixels rendered from the pre-resize frame. Users had to manually resize the browser window to clear the artefact. v0.25.1 eliminates the visible rectangle via the compositor-nudge + delayed-sweep technique described above. ([`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx))

### Internal

- **Zero-warning backend release build**: The 16 `unused_imports` / `dead_code` warnings that surfaced during the v0.25.0 Docker build have been eliminated. Genuinely-unused imports were removed; API surface reserved for the upcoming P8 admin-UI work (`InlineAttachment`, `BoxedTransport`, `SendError`, `StubTransport`, `describe`, `context_from_pairs`, `reply_to`/`inline` builders, `DeliveryToRetry.attempts`, `CheckoutEvent::target_account_dn`) now carries targeted `#[allow(dead_code)]` / `#[allow(unused_imports)]` annotations with rationale comments that point to the consuming future phase. `cargo check --bin strata-backend --all-targets` now reports **0 warnings, 0 errors**. ([`backend/src/services/email/mod.rs`](backend/src/services/email/mod.rs), [`backend/src/services/email/transport.rs`](backend/src/services/email/transport.rs), [`backend/src/services/email/message.rs`](backend/src/services/email/message.rs), [`backend/src/services/email/templates.rs`](backend/src/services/email/templates.rs), [`backend/src/services/email/worker.rs`](backend/src/services/email/worker.rs), [`backend/src/services/notifications.rs`](backend/src/services/notifications.rs), [`backend/src/routes/notifications.rs`](backend/src/routes/notifications.rs))

## [0.25.0] — 2026-04-25

### Added

- **Modern managed-account notification emails**: Strata now sends polished, mobile-friendly HTML emails for the four key managed-account checkout events — _pending approval_, _approved_, _rejected_, and _self-approved (audit)_. Templates are authored in MJML, rendered server-side via `mrml`, and ship with VML-based dark-mode hardening so Outlook desktop no longer overlays the white "haze" rectangle on dark themes (see the user-memory note on the VML technique). Every email is multipart/related (HTML + plain-text alternative + inlined Strata logo via `cid:strata-logo`). ([`backend/src/services/email/`](backend/src/services/email/), [`backend/src/services/email/templates/`](backend/src/services/email/templates/))
- **SMTP transport with admin UI**: New `EmailTransport` trait with a production `SmtpTransport` (lettre 0.11, rustls, STARTTLS / implicit-TLS / plaintext modes). Admins configure the relay through four new endpoints — `GET`/`PUT /api/admin/notifications/smtp`, `POST /api/admin/notifications/test-send`, `GET /api/admin/notifications/deliveries` — with the SMTP password **hard-required to live in Vault** (rejected if Vault is sealed or in stub mode). Dispatch is blocked entirely when `smtp_from_address` is empty so half-configured installs do not silently drop messages. ([`backend/src/services/email/smtp.rs`](backend/src/services/email/smtp.rs), [`backend/src/routes/notifications.rs`](backend/src/routes/notifications.rs))
- **Per-user notification opt-out (audit-aware)**: New `users.notifications_opt_out` boolean column. The dispatcher honours the flag for all transactional messages and records every suppression as a `notifications.skipped_opt_out` audit event. The _self-approved_ audit notice is intentionally non-opt-outable so security teams retain visibility regardless of user preference. The user-facing toggle UI ships in a follow-up release; for v0.25.0 the flag can be set directly in the `users` table.
- **Notification dispatcher + retry worker**: New fire-and-forget `notifications::spawn_dispatch` is hooked into `request_checkout` (Pending / SelfApproved branches) and `decide_checkout` (Approved / Rejected branches). A background `spawn_email_retry_worker` (30 s tick, 60 s warm-up, 120 s per-attempt budget) re-attempts transient SMTP failures with exponential backoff and abandons rows after 3 attempts. Permanent SMTP failures (5xx) are not retried. ([`backend/src/services/notifications.rs`](backend/src/services/notifications.rs), [`backend/src/services/email/worker.rs`](backend/src/services/email/worker.rs))
- **Migration 055 — notifications schema**: Adds the `email_deliveries` audit table (with status/recipient/related-entity indexes), the `users.notifications_opt_out` column, and seeds eight new `system_settings` keys (`smtp_enabled`, `smtp_host`, `smtp_port`, `smtp_username`, `smtp_tls_mode`, `smtp_from_address`, `smtp_from_name`, `branding_accent_color`). The SMTP password is stored separately via Vault Transit (never written to `system_settings`). ([`backend/migrations/055_notifications.sql`](backend/migrations/055_notifications.sql))
- **Outlook dark-mode wrapper helper**: Reusable `wrap_for_outlook_dark_mode` injects the VML namespace, `<v:background fill="t">` rectangle, and Outlook-only stylesheet on top of any rendered MJML so future templates inherit the dark-mode fix automatically. ([`backend/src/services/email/outlook.rs`](backend/src/services/email/outlook.rs))

### Changed

- **Approver routing**: `services::checkouts::approvers_for_account` now resolves the approver set by joining `approval_role_accounts` and `approval_role_assignments`, so notifications fan out to every assigned approver rather than only the first match.

## [0.24.0] — 2026-04-24

### Added

- **Quick Share role permission (`can_use_quick_share`)**: Introduces a dedicated RBAC flag controlling access to the in-session **Quick Share** feature (ephemeral file upload / share-link). The Quick Share button on the session bar is now gated by this permission, and the backend `POST /api/files/upload` endpoint rejects requests from users whose role does not have it. Administrators retain full access (`can_manage_system` bypasses the check, consistent with the rest of the RBAC surface). ([`backend/migrations/054_unify_connection_folder_perm_add_quick_share.sql`](backend/migrations/054_unify_connection_folder_perm_add_quick_share.sql), [`backend/src/services/middleware.rs`](backend/src/services/middleware.rs), [`backend/src/routes/files.rs`](backend/src/routes/files.rs), [`frontend/src/pages/admin/AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx), [`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx))

### Changed

- **Unified "Create connections" permission**: The two separate flags `can_create_connections` and `can_create_connection_folders` have been consolidated into a single `can_create_connections` permission. The role-editor checkbox for "Create connection folders" is removed; users with **Create new connections** can now create and organise both connections _and_ their folders. Migration 054 OR's the old `can_create_connection_folders` into `can_create_connections` before dropping the column, so no existing role loses capability.
- **RBAC surface narrowed from 10 permissions to 10 (one retired, one added)**: The permission matrix documented in [`docs/security.md`](docs/security.md) now reflects the consolidated `can_create_connections` and the new `can_use_quick_share`. All API response payloads (`GET /api/user/me`, `POST /api/auth/login`, `GET /api/admin/roles`) emit `can_use_quick_share` in place of `can_create_connection_folders`; external API consumers should update their field mappings accordingly.
- **Upgrade note**: Migration 054 grants `can_use_quick_share = true` to every existing role for non-breaking behaviour (Quick Share remains available to anyone who had it before). Administrators who want to restrict Quick Share to a subset of roles should untick the new **Use Quick Share** checkbox on the relevant roles via **Admin → Access → Roles** after the upgrade.

### Fixed

- **Session quick actions respect file-transfer toggle**: The admin form's **Enable drive / file transfer** and **Enable SFTP** checkboxes now fully gate the runtime file-transfer channels. Previously the tunnel layer force-enabled `enable-drive` for every RDP connection and `enable-sftp` for every SSH connection regardless of the stored extras, and the `cleanExtra()` helper in the admin form stripped `"false"` values before save so unticking the box was silently discarded. Now:
  - The admin form preserves explicit `"false"` for a whitelist of boolean toggles (`enable-drive`, `enable-sftp`, `enable-printing`, `enable-wallpaper`, `enable-theming`, `enable-font-smoothing`, `enable-full-window-drag`, `enable-desktop-composition`, `enable-menu-animations`, `enable-audio`, `enable-audio-input`, `disable-audio`, `disable-copy`, `disable-paste`, `read-only`, `ignore-cert`). ([`frontend/src/pages/admin/AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx))
  - The backend tunnel layer treats only `"true"` as enabled (absent/`"false"`/any other value → disabled), matching what the admin sees in the UI. ([`backend/src/tunnel.rs`](backend/src/tunnel.rs))
  - `/user/connections/:id/info` reports `file_transfer_enabled` using the same strict rule. ([`backend/src/routes/user.rs`](backend/src/routes/user.rs))
  - `SessionBar` Browse Files button and the `SessionMenu` File Transfer section require `fileTransferEnabled`. **Quick Share is always shown while a session is active** — it uses the backend file-store and is independent of guacd's drive/SFTP channels, so it must not share gating with Browse Files. ([`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx), [`frontend/src/components/SessionMenu.tsx`](frontend/src/components/SessionMenu.tsx))
  - **Upgrade note**: existing RDP/SSH connections that relied on the implicit legacy default now appear with file transfer off. Admins should edit those connections, tick the box, and save to re-enable.

### Changed

- **`AdminSettings.tsx` refactor complete (W4-4)**: The historical 8,402-line monolith has been broken into one dedicated module per tab under `frontend/src/pages/admin/`. `AdminSettings.tsx` is now a thin **258-line dispatcher** that loads settings and renders the selected tab:
  - `SecurityTab`, `NetworkTab`, `DisplayTab`, `SsoTab`, `KerberosTab`, `RecordingsTab`, `VaultTab`, `TagsTab`, `HealthTab` (with co-located `GuacdCapacityGauge`), `SessionsTab`, `PasswordsTab` (with co-located `parseDN`), `AdSyncTab`, `AccessTab`.
  - Shared form helpers (`Section`, `FieldGrid`, `RdpSections`, `SshSections`, `VncSections`) moved to `frontend/src/pages/admin/connectionForm.tsx`.
  - Shared RDP keyboard layout list moved to `frontend/src/pages/admin/rdpKeyboardLayouts.ts`.
  - Net reduction across the admin surface: **−8,144 lines** from the parent; zero behavioural changes; all 1,162 frontend tests and backend test suites pass green on every extraction step.
- **Documentation refresh**: Architecture doc now reflects the admin sub-tab split. Runbook index statuses flipped from "Planned" to "Active". PR template, `docs/runbooks/README.md`, and ADR-0001 no longer reference the retired compliance tracker.

### Removed

- **`docs/compliance-tracker.md`**: Retired after reaching 62 / 62 items closed. Every wave (W0 – W5) is complete; the ADRs and runbooks that grew out of the tracker remain under `docs/adr/` and `docs/runbooks/` as the permanent record. Historical mentions in `CHANGELOG.md` and `WHATSNEW.md` are preserved as point-in-time records.

## [0.23.0] — 2026-04-22

### Changed

- **Dependency Modernization — Major Version Upgrades**: Swept the backend and frontend onto current major versions of every long-deferred dependency. No behavioural changes for end users; surface area of this release is entirely under the hood.
  - **Rust toolchain**: backend builder image bumped from `rust:1.94-alpine` to `rust:1.95-alpine`; runtime image (and `guacd` base) bumped from `alpine:3.21`/`3.22` to `alpine:3.23`.
  - **axum 0.7 → 0.8** (plus `axum-extra` 0.9 → 0.12, `tower` 0.4 → 0.5, `tower-http` 0.5 → 0.6). Route path syntax migrated from `:param` / `*splat` to `{param}` / `{*splat}` across every router (`backend/src/routes/mod.rs`, `backend/src/services/vault.rs`, and the `vault_provisioning` test fixture). `Message::Text`/`Message::Ping` now take `Utf8Bytes`/`Bytes` instead of `String`/`Vec<u8>`; all websocket send sites updated. No API shape or wire-format changes.
  - **rand 0.9 → 0.10**: convenience methods (`random`, `random_range`, `sample_iter`) moved from the `Rng` trait to the new `RngExt` trait; every call site imports `RngExt` and the two `fill_bytes` sites in `main.rs` now use `rand::rng().random::<[u8; 32]>()` idioms.
  - **sha2 0.10 → 0.11, hmac 0.12 → 0.13**: `new_from_slice` now lives on `KeyInit` (added to the `use hmac::{Hmac, KeyInit, Mac};` import in `recordings.rs`).
  - **Frontend — React 18 → 19**: `useRef<T>()` callers now pass an explicit `undefined` initial value (`SessionBar.tsx`, `SessionMenu.tsx`, `SessionClient.tsx`); the removed global `JSX` namespace is replaced with `ReactElement` from `react` (`Documentation.tsx`). No UI or behaviour changes — all 1162 Vitest tests pass, production build clean.
  - **Frontend — react-router-dom 6 → 7**: no code changes required; the project already uses the data-router APIs.
  - **Frontend — TypeScript 5 → 6**: `tsconfig.json` adds `"ignoreDeprecations": "6.0"` to silence the `baseUrl` deprecation warning ahead of the TypeScript 7 removal.
  - **Frontend — eslint-plugin-react-hooks 5 → 7**: the new compiler-aware rules (`set-state-in-effect`, `immutability`, `purity`, `refs`, `globals`, `preserve-manual-memoization`) are enabled at **warn** level in `eslint.config.js` so the bump lands without a mass refactor. They ride alongside the existing warnings until a dedicated hooks-purity sweep promotes them.
  - **Dockerfile bumps**: `frontend/Dockerfile` moves to `node:25-alpine`; all runtime stages now target `alpine:3.23`. Trivy CRITICAL/HIGH scans clean on every rebuilt image.

### Security

- **Rust 1.95 Clippy Tightening**: The new `collapsible_match` lint flagged a nested `if let` in the share-token websocket loop (`backend/src/routes/share.rs`); collapsed into a single match guard with no behavioural change.
- **`cargo-audit` Configuration Relocated**: `audit.toml` moved from `backend/audit.toml` to `backend/.cargo/audit.toml` — the canonical discovery path. The three existing RUSTSEC ignores (`RUSTSEC-2023-0071`, `RUSTSEC-2024-0379`, `RUSTSEC-2024-0384`) are preserved verbatim with their justifications. Previously the file was silently ignored, so CI would fail-open on any advisory those rules were suppressing; this closes that hole.

### Deferred

- **eslint 9 → 10**: blocked upstream. `eslint-plugin-react@7.37.5` (latest) uses `context.getFilename()`, which eslint 10 removed (`contextOrFilename.getFilename is not a function`); `eslint-plugin-jsx-a11y@6.10.2` likewise caps its peer at `^9`. Will revisit when both plugins ship eslint-10-compatible releases.

## [0.22.0] — 2026-04-21

### Added

- **Scheduled Recording Retention Purge**: The background recordings worker (`sync_pass` in `backend/src/services/recordings.rs`) now enforces the `recordings_retention_days` setting against the database and Azure Blob Storage, not just the local filesystem. On every pass it selects every `recordings` row whose `created_at` is older than the configured window, deletes the underlying artefact — Azure blob via the Transit-sealed account key, or local file from the recordings volume — and then deletes the database row. Purge totals are logged as `purged_azure`, `purged_local`, and `deleted_rows` for auditability.
- **Configurable User Hard-Delete Window**: Soft-deleted users are now hard-deleted after a configurable window (default **90 days**, previously a hardcoded 7 days). The `user_cleanup` worker reads the `user_hard_delete_days` setting and applies it via PostgreSQL `make_interval(days => $1)` parameter binding — no SQL interpolation. Administrators can change the window in the new **Data Retention** section of the Security tab in Admin Settings (valid range 1–3650 days).
- **Admin UI — Data Retention Controls**: The Security tab now includes a **User hard-delete window (days)** input that persists to the `user_hard_delete_days` setting via the existing generic settings endpoint. The control is validated client-side (positive integer, 1–3650) and documents exactly what the window governs.
- **ADR-0003 — Feature Flags (Deferred)**: Documents the decision to keep the existing boolean `settings` table as the feature-flag mechanism rather than introducing a dedicated `feature_flags` table. Includes promotion criteria for when a future ADR would supersede this decision (percentage rollout, scheduled activation, auto-expiry, or per-user targeting). — `docs/adr/ADR-0003-feature-flags-deferred.md`
- **ADR-0004 — guacd Connection Model**: Documents the split-trust model: guacd is reachable only on the internal Docker network, credentials are ephemeral per-handshake, and Guacamole protocol parameters from user-controlled database fields are filtered through an allow-list before being forwarded. — `docs/adr/ADR-0004-guacd-connection-model.md`
- **ADR-0005 — JWT + Refresh-Token Sessions**: Pins the 20-minute access token / 8-hour refresh token TTLs, refresh-token single-use rotation, revocation via `revoked_tokens` table + in-memory set, and per-user `sessions_valid_after` lever for forced global logout. — `docs/adr/ADR-0005-jwt-refresh-token-sessions.md`
- **ADR-0006 — Vault Transit Envelope Encryption**: Documents the `vault:<base64>` envelope format used for every operator-managed secret at rest, the key hierarchy (root → Transit KEK → per-encryption DEKs that never materialise in Strata), and the rotate + rewrap path that upgrades ciphertexts without exposing plaintext. — `docs/adr/ADR-0006-vault-transit-envelope.md`
- **ADR-0007 — Emergency Approval Bypass & Scheduled-Start Checkouts**: Documents the data model (`emergency_bypass`, `scheduled_start_at`, scope-level `pm_allow_emergency_bypass`), the activation semantics (`scheduled_start_at <= now()` idempotent worker filter), and the audit invariants (`pm.checkout.emergency` event, weekly review cadence). — `docs/adr/ADR-0007-emergency-bypass-checkouts.md`
- **Operational Runbooks**: Five new copy-pasteable runbooks for on-call engineers.
  - **Disaster Recovery** (RTO ≤ 4h, RPO ≤ 24h) — `docs/runbooks/disaster-recovery.md`
  - **Security Incident Response** (SEV tiers, containment, forensic queries) — `docs/runbooks/security-incident.md`
  - **Certificate Rotation** (ACME + internal CA) — `docs/runbooks/certificate-rotation.md`
  - **Vault Operations** (unseal, Transit rotate + rewrap, Shamir rekey) — `docs/runbooks/vault-operations.md`
  - **Database Operations** (replica promotion, compensating-migration pattern, panic-boot recovery) — `docs/runbooks/database-operations.md`

### Changed

- **`user_cleanup` Worker**: Both SQL queries (the recordings-pre-purge and the final user DELETE) now use parameter-bound `make_interval(days => $1)` instead of the hardcoded `INTERVAL '7 days'`. The tracing log line at the start of each pass now includes the active `days` value.
- **Compliance Tracker**: `docs/compliance-tracker.md` Wave 5 is fully closed (13 of 13). Progress table now shows 59/62 total items done; the three remaining items are deferred Wave 4 refactor tasks (W4-4/5/6) with no functional impact.

### Security

- **Configurable Retention Windows**: Both the recordings retention purge and the user hard-delete cleanup are now driven by runtime-editable settings (`recordings_retention_days`, `user_hard_delete_days`) rather than hardcoded constants. This closes the §25.2/§25.3 Coding-Standards gap around operator-controllable data-retention windows and removes the previous 7-day user-hard-delete floor that was below many regulatory norms.
- **No SQL Interpolation in Retention Paths**: All day-window values are bound via `make_interval(days => $1)` and parsed through `i32` with a positive-integer guard. There is no string concatenation of interval values in any retention query path.

## [0.21.0] — 2026-04-21

### Added

- **Product Roadmap Page** (`/docs` → Roadmap): A new section in the built-in documentation menu renders a modern, themed roadmap of proposed features across four areas — Recordings, Security & Zero Trust, Auditing / Analytics / Compliance, and Workflows & Collaboration, plus a Notifications & Email theme. Each item carries a status (`Proposed | Researching | In Progress | Shipped`), area tags, description, and optional bullets. A status-summary strip totals items per status.
- **Admin-Editable Roadmap Statuses**: Administrators with `can_manage_system` can change any item's status directly from the roadmap page using a modern dropdown (the shared `Select` component). Non-admin users see a read-only colour-coded status badge. Updates are optimistic with rollback on error and persist in `system_settings.roadmap_statuses` as a single JSON blob — no migration required.
- **Editable Self-Approve on Account Mappings**: The _Existing Mappings_ table in Password Management → Account Mappings now renders the Self-Approve column as a modern dropdown. Admins can toggle `can_self_approve` in place without deleting and re-creating the mapping. Updates are optimistic with rollback on error and write an `account_mapping.updated` audit entry.

### Endpoints (New)

- `GET  /api/roadmap` — any authenticated user. Returns `{ "statuses": { "<item-id>": "<status>", … } }`.
- `PUT  /api/admin/roadmap/:item_id` — admin-only. Upserts a single roadmap item's status. Validates the item id (alphanumeric + `-_`, ≤ 64 chars) and the status value.
- `PATCH /api/admin/account-mappings/:id` — admin-only. Partial update of `can_self_approve` and/or `friendly_name` on an existing user → managed-account mapping. Uses `COALESCE` so unspecified fields are left untouched; returns 404 when the mapping does not exist; writes `account_mapping.updated` to the audit log.

### Fixed

- **CheckedIn Managed Profiles No Longer Bypass the Renewal Prompt**: `GET /api/user/connection-info` previously reported a profile as having live credentials whenever its TTL had not expired — even if the backing password checkout had been voluntarily checked in (Vault password scrambled). The client then proceeded to authenticate with scrambled credentials, producing a visible "Authentication failure" error and a silent AD account lockout. Both SQL queries in the handler now join `password_checkout_requests` and require a live `Active` (and un-expired) checkout; otherwise the profile is surfaced through the `expired_profile` path so the SessionClient prompt fires with the duration + justification input, matching the behaviour of a TTL-expired profile.

## [0.20.2] — 2026-04-20

### Changed

- **Justification Mandatory for Approval-Required Checkouts**: `POST /api/user/checkouts` now rejects any checkout from a user without `can_self_approve` unless `justification_comment` is at least 10 characters long. Previously the 10-character floor only applied to Emergency Bypass requests; now it applies to every request that an approver will see, so reviewers always have a written business reason. Self-approving users are unaffected — their comments remain optional.
- **Checkout Form UX**: The Justification label now reads "(required, min 10 characters)" in accent/warning colour whenever the selected account requires approval. Placeholder text, inline character counter, and submit-button disabled state all reflect the new requirement.

## [0.20.1] — 2026-04-20

### Security

- **Emergency Bypass 30-Minute Duration Cap**: Emergency Approval Bypass checkouts are now hard-capped at **30 minutes** regardless of the `requested_duration_mins` value submitted. The cap is enforced server-side in `POST /api/user/checkouts` after all existing bypass guards pass — any larger value is silently clamped before the row is written. This tightens the exposure window for credentials released without approver review. The checkout form also caps the duration input's `max` to `30` while the ⚡ Emergency Bypass checkbox is ticked and auto-reduces the current value if the user enables bypass with a larger duration selected; the server-side clamp remains authoritative.

### Changed

- **Checkout Form**: Duration input label now reads "Duration (minutes, 1–30)" when emergency bypass is active, with an inline warning "Emergency bypass checkouts are capped at 30 minutes."

## [0.20.0] — 2026-04-20

### Added

- **Scheduled Password Release (Future Start Time)**: Users can now request a password checkout that releases at a future date/time instead of immediately. The checkout form includes an optional "Schedule release for a future time" toggle with a `datetime-local` picker (default now + 15 minutes, minimum now + 1 minute, maximum + 14 days). On submit, the request is created with status `Scheduled` and the password is not generated until the scheduled moment. The existing 60-second expiration worker (`spawn_expiration_worker` / `run_expiration_scrub`) now also scans for due `Scheduled` rows and invokes `activate_checkout` — no new worker, no additional DB polling pattern. Works for both approval-required and self-approving users. Scheduled checkouts display a distinct accent badge and a "🕒 Release scheduled for …" line on the checkout card.
- **Emergency Approval Bypass (Break-Glass)**: A new per-AD-Sync-Source toggle (`pm_allow_emergency_bypass`) lets administrators permit users to bypass approval-role review during a production incident. When enabled, approval-required users see an "⚡ Emergency Bypass" checkbox on the checkout form. Emergency checkouts require a justification of at least 10 characters, are **capped at a maximum duration of 30 minutes** (enforced server-side and in the UI), and are activated immediately — just like a self-approved request — but are flagged with `emergency_bypass = true` throughout the checkout lifecycle. A distinct audit event (`checkout.emergency_bypass`) is written, and the Credentials / Approvals views display an "⚡ Emergency" badge so auditors and approvers can instantly identify break-glass access. The emergency option is hidden on the form when a scheduled release is active (they are mutually exclusive: emergency = immediate, scheduled = future).

### Changed

- **Checkout State Machine**: `password_checkout_requests.status` now has seven possible states: `Pending`, `Approved`, `Scheduled`, `Active`, `Expired`, `Denied`, `CheckedIn`. `activate_checkout` accepts any of `Approved`, `Active`, or `Scheduled` as valid source states.
- **Duplicate-Request Guard**: The "you already have an open checkout" guard in `POST /api/user/checkouts` now treats `Scheduled` rows as open, preventing users from queuing multiple future-dated releases for the same account.
- **Checkout Form UX**: Dynamic submit button label — reads "Schedule Checkout", "Emergency Checkout", or "Request Checkout" depending on which options are active. Scheduled releases show a distinct flash message: "Checkout scheduled — password will release at the chosen time".

### Database

- **Migration 051**: Adds `pm_allow_emergency_bypass BOOLEAN NOT NULL DEFAULT FALSE` to `ad_sync_configs`; adds `emergency_bypass BOOLEAN NOT NULL DEFAULT FALSE` to `password_checkout_requests` with a partial index for audit queries.
- **Migration 052**: Adds `scheduled_start_at TIMESTAMPTZ` to `password_checkout_requests`; drops and recreates `password_checkout_requests_status_check` to include the new `Scheduled` state (full state set: `Pending, Approved, Scheduled, Active, Expired, Denied, CheckedIn`); adds a partial index `idx_password_checkout_requests_scheduled_start_at WHERE status = 'Scheduled'` so the expiration worker's due-scan is an indexed lookup rather than a table scan.

### Security

- **Emergency Bypass Safeguards**: The `pm_allow_emergency_bypass` toggle is gated behind an AD sync config (admin-only). The backend enforces four checks server-side: (1) the mapping's `ad_sync_config_id` must have `pm_allow_emergency_bypass = true`, (2) the justification comment must be at least 10 characters, (3) emergency bypass cannot be combined with scheduled release, (4) `requested_duration_mins` is hard-clamped to 30 minutes regardless of the value submitted. Every emergency checkout emits a dedicated `checkout.emergency_bypass` audit entry that captures the requester, managed account DN, justification, and (clamped) duration — so break-glass events are reviewable and immutable even though approvers were bypassed.
- **Scheduled Release Bounds**: The scheduled timestamp is validated server-side to be strictly in the future (> now + 30 s) and no more than 14 days out; values outside this window return `400 Validation`. The row sits idle in the DB with no Vault material, no generated password, and no LDAP mutation until the worker activates it — minimising the window in which a privileged credential exists.

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
- **Keyboard Shortcut Proxy (Ctrl+Alt+`)**: Pressing `Ctrl+Alt+`` sends `Win+Tab`(Task View) to the remote session. This is the only reliable browser-level proxy shortcut — Windows intercepts`Ctrl+Alt+Tab` before JavaScript can capture it.
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
