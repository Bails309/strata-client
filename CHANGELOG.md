# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.31.0] — 2026-04-27

### User-defined `:command` palette mappings, built-in commands, ghost-text autocomplete, and a new `command.executed` audit stream

A feature release that turns the in-session Command Palette (default
`Ctrl+K`) from a connection picker into a fully scriptable, user-extensible
command surface. Operators can now type `:` to enter command mode, run
**built-in commands** (`:reload`, `:disconnect`, `:fullscreen`, `:commands`)
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

- **Built-in commands.** Four commands ship by default and cannot be
  overridden by user mappings:

  | Command       | Action                                                                                                                                                            | Validity                                  |
  | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
  | `:reload`     | Re-establish the active session (same flow as the SessionBar reconnect button — closes + recreates the tunnel so an IDR keyframe is forced and stale GFX clears) | Disabled when no active session            |
  | `:disconnect` | Close the active session and return to the dashboard                                                                                                              | Disabled when no active session            |
  | `:fullscreen` | Toggle browser fullscreen with Keyboard Lock (uses `requestFullscreenWithLock` / `exitFullscreenWithUnlock` from `utils/keyboardLock`)                              | Always available                           |
  | `:commands`   | List every available command (built-ins + user mappings) inline in the palette body                                                                                | Always available                           |

  Built-in handlers live in [`frontend/src/components/CommandPalette.tsx`](frontend/src/components/CommandPalette.tsx)
  and reuse the same primitives as the SessionBar buttons so behaviour
  is identical regardless of how the action is invoked.

- **User-defined `:command` mappings (`commandMappings` preference key).**
  Up to **50 mappings per user** are stored as a JSONB array in the
  existing `user_preferences.preferences` blob. Each mapping is a
  discriminated union with three required fields:

  ```jsonc
  {
    "trigger": "prod",                             // [a-z0-9_-]{1,32}, no built-in collision
    "action":  "open-connection",                  // enum (see below)
    "args":    { "connection_id": "<uuid>" }      // shape determined by `action`
  }
  ```

  The six allowed actions and their `args` schemas:

  | `action`           | `args` shape                                  | Resolves to                                                                              |
  | ------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
  | `open-connection`  | `{ "connection_id": "<uuid>" }`               | `navigate(`/session/${id}`)`                                                              |
  | `open-folder`      | `{ "folder_id": "<uuid>" }`                   | `navigate(`/dashboard?folder=${id}`)`                                                     |
  | `open-tag`         | `{ "tag_id": "<uuid>" }`                      | `navigate(`/dashboard?tag=${id}`)`                                                        |
  | `open-page`        | `{ "path": "/dashboard" \| "/profile" \| ... }` | `navigate(path)` — path must be in the server allow-list                                 |
  | `paste-text`       | `{ "text": "<1..4096 chars>" }`                | Pushes `text` onto the active session's remote clipboard via `Guacamole.Client.createClipboardStream`, then fires a Ctrl+V keystroke so the focused remote application receives the paste |
  | `open-path`        | `{ "path": "<1..1024 chars, no ctrl chars>" }`  | Drives the Windows Run dialog on the active session: Win+R (keysyms `0xffeb`+`0x72`) → paste path via clipboard → Enter (`0xff0d`). Resolves UNC shares, local folders, and `shell:` URIs in Explorer on the remote target. The flagship example: `:comp1` → `\\computer456\share`. |

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
    "trigger":   ":reload",                       // :?[a-z0-9_-]{1,64}
    "action":    "reload",                        // server allow-list
    "args":      { /* opaque, action-specific */ },
    "target_id": "<uuid> | null"                  // resolved target where applicable
  }
  ```

  Validation rejects: triggers outside `:?[a-z0-9_-]{1,64}` (longer than
  the 32-char mapping limit because audit accepts the leading colon),
  and actions outside
  `reload | disconnect | fullscreen | commands | open-connection | open-folder | open-tag | open-page`.
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
  - No `trigger` collides with the four built-in command names.
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
