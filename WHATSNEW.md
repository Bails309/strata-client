# What's New in v0.26.0

> **Hardening release.** v0.26.0 is the result of an end-to-end code review across the backend and frontend, followed by a focused sweep of security, audit, and reliability fixes. No breaking API changes, one additive migration (056), drop-in upgrade.

---

## 🔒 Security & audit hardening

### Share tokens respect connection soft-deletes

Before v0.26.0, a share link minted against a connection that was subsequently soft-deleted would continue resolving — viewers hitting the `/share/:token` URL got routed at the stale connection metadata. `services::shares::find_active_by_token` now JOINs `connections` and filters `soft_deleted_at IS NULL`, so a deleted connection's shares stop working the moment the delete commits, even if the share row itself is still live.

### Brute-force isolation on shared tunnel rate limit

The `SHARE_RATE_LIMIT` overflow path used to call `map.clear()`, which meant an attacker spamming unique tokens could **reset every legitimate token's counter as a side-effect**. The new behaviour is a two-step LRU eviction: first drop entries whose windows have fully expired, then — only if still over the cap — evict the oldest-attempt entries. Real users' rate-limit state is unaffected by noise.

### Share rejection paths emit audit events

Two new event types appear in `audit_logs`:

- `connection.share_rate_limited` — emitted when a share URL hits the per-token rate limit
- `connection.share_invalid_token` — emitted when a lookup misses

Both carry a SHA-256-prefix fingerprint of the token (8 hex chars, the raw token is never persisted) plus the client IP, so operators can see probing activity against their share links without any PII leaks.

### User-route audit coverage gaps closed

Several self-service mutations were previously silent. They now emit audit events:

| Handler | Event |
|---|---|
| `POST /api/user/accept-terms` | `user.terms_accepted` |
| `PUT /api/user/credential-mappings` | `user.credential_mapping_set` |
| `DELETE /api/user/credential-mappings/:connection_id` | `user.credential_mapping_removed` |
| `POST /api/user/checkouts/:id/retry` | `checkout.retry_activation` |
| `POST /api/user/checkouts/:id/checkin` | `checkout.checkin` |

### Vault error paths sanitized

When Vault returns a server error or the HTTP transport fails, the full body / error detail is now emitted at `tracing::debug!` only. API callers see a generic `"Vault <status>"` or `"Vault request transport error"` message — no more raw Vault JSON leaking through to the client on a misconfigured instance.

### StubTransport compiled out of release builds

The in-memory test transport is now gated behind `#[cfg(test)]`. No path in a production binary can retain rendered message bodies (which can include justification strings and ephemeral credentials) in memory.

---

## 🛠️ Reliability & performance

### Input latency eliminated under bitmap bursts

The single biggest user-facing fix in v0.26.0. The WebSocket tunnel's proxy loop used to call `ws.send(...).await` inline inside the guacd→browser `tokio::select!` arm. Under heavy draw bursts — the classic symptom being a Win+Arrow window snap spewing a lot of bitmap updates in ~200 ms — the browser's WS receive buffer would fill, `ws.send().await` would block, and **while it was blocked the `ws.recv()` arm could not run**. So mouse movements and keystrokes queued up in the kernel TCP buffer and only flushed when the back-pressure relieved, producing three symptoms that were consistently reported together:

- Rendering freezes
- Mouse movement that felt like mouse acceleration had been turned on (a burst of queued movements arriving at once)
- Keyboard lag on the same timescale

The fix decouples the WebSocket sender from the select loop:

- `ws.split()` → `ws_sink` + `ws_stream`
- A bounded mpsc channel (1024 messages) sits in front of the sink
- A dedicated writer task drains the channel into the sink
- Every former `ws.send(...).await` call site now pushes to the channel — a fast in-memory append when the channel isn't full

Input-path latency is now independent of output-path backpressure. On the frontend, `display.onresize` events are coalesced to one `handleResize` per animation frame (FreeRDP 3 emits multiple partial size updates during snap animations), and the pending-buffer drain on the backend is now `O(remainder)` instead of `O(n)` via `Vec::drain`.

### Tunnel overflow emits a proper error frame

When guacd ever sends a single instruction larger than the pending-byte ceiling, the tunnel used to silently call `pending.clear()` — from the user's perspective the session would drop frames for no apparent reason. It now dispatches a Guacamole `error "…" "521"` to the websocket and closes the stream cleanly, so clients see exactly why the session ended.

### Indexed email retry sweep (migration 056)

The email retry worker runs `SELECT … WHERE status='failed' AND attempts<3 ORDER BY created_at` every 30 seconds. Without an index this became a seq-scan once `email_deliveries` grew. Migration `056_email_deliveries_retry_idx.sql` adds a partial index:

```sql
CREATE INDEX email_deliveries_retry_idx
    ON email_deliveries (created_at)
    WHERE status = 'failed' AND attempts < 3;
```

The index stays tiny because the retryable population is tiny.

### Settings cache TTL: 30 s → 5 s

Admin toggles (feature flags, branding, SMTP enable) used to take up to 30 seconds to propagate across replicas. The cache TTL is now 5 seconds, keeping operator feedback near-instant while still absorbing the hot-path read burst from auth middleware. A pg NOTIFY-based invalidator remains on the roadmap for zero-staleness.

---

## ✨ Admin UX polish

### Notifications tab — template test-send picker

The SMTP test-send panel gained a dropdown next to the recipient input letting admins dry-run **any of the real notification templates** (checkout requested / approved / denied / expiring) against their live relay. The backend renders the real MJML template with a synthetic sample context (requester, approver, justification, expiry), prefixes the subject with `[TEST]` so it can't masquerade as a real notification, and pulls the `tenant_base_url` and `branding_accent_color` from the live settings so the preview reflects the operator's actual branding.

### Port & TLS dropdowns are now bidirectionally symmetric

Picking a canonical port (25 / 465 / 587) now also snaps the TLS mode to the conventional pairing (so port 465 → Implicit TLS, 587 → STARTTLS), mirroring the pre-existing "TLS mode snaps port" behaviour. The two dropdowns can no longer drift into nonsensical combinations like *port 465 + STARTTLS*.

### Password field: discriminated union

Frontend callers used to pass `password: undefined | "" | string` to `updateSmtpConfig` with a three-way semantic (keep / clear / set). That's now an explicit discriminated union:

```ts
password: { action: "keep" } | { action: "clear" } | { action: "set", value: string }
```

The wire format is unchanged — the API client serializes back to the old shape at the request boundary — but the intent is now unambiguous in every caller.

---

## 📚 Docs & roadmap hygiene

- **Roadmap retention policy** codified in `docs/roadmap.md`: shipped items are visible for the minor line in which they landed and pruned at the next minor bump. No items in the markdown roadmap were flagged Shipped during the v0.25.x line, so nothing needs removing here — but the policy is now in place for future minor bumps.

---

## 📦 Upgrade notes

- **Database migration** — one additive migration: `056_email_deliveries_retry_idx.sql`. Safe on every supported Postgres version, no table locks beyond the `CREATE INDEX`.
- **Breaking API changes** — none. Frontend `SmtpConfigUpdate.password` type changed, but the backend wire format is identical.
- **Version bump** — `VERSION`, `frontend/package.json` (+ lock), `backend/Cargo.toml` (+ lock), and the README badge now read **0.26.0**.

---

# What's New in v0.25.2

> **The missing admin tab.** v0.25.2 ships the **Admin → Notifications** tab that the v0.25.0 release notes described but — as an observant administrator pointed out — never actually landed in the UI. The backend endpoints have been running since v0.25.0; this release puts a proper front-end on top of them. No migrations, no API changes, drop-in upgrade.

---

## 🖥️ Admin → Notifications — the SMTP configuration UI

A new top-level tab appears on the Admin Settings page (visible to users with `can_manage_system`). It is split into three sections:

### 1. SMTP relay configuration

Standard form fields for **host**, **port**, **TLS mode** (STARTTLS / Implicit TLS / None), **username**, **From address**, **From name**, and **brand accent colour** (used as the button colour in the HTML templates). The **Enable notification emails** master switch at the top is honoured by the dispatcher — off means *no outbound mail*, no TCP connection to the relay, no `email_deliveries` row churn.

### 🔐 The password field is Vault-aware

Because the SMTP password is **sealed into Vault server-side** (the backend rejects the PUT if Vault is sealed or in stub mode — see v0.25.0 notes), the UI never shows the actual stored value. Instead:

- An empty input with a **"•••••••• (sealed in Vault)"** placeholder appears when a password is already on file.
- Typing a new value and saving seals and replaces the stored secret.
- A **Keep existing** button discards your edit and leaves the stored value alone.
- A **Clear** button (only visible when a password is on file and you haven't started typing a new one) lets you remove the stored password on save — useful if you're switching to a relay that accepts anonymous SMTP from your subnet.

Three-state semantics are wired end-to-end: the `password` field on the PUT body is `undefined` to keep, `""` to clear, or a non-empty string to replace.

### 2. Send test email

A dedicated panel with a recipient input and a **Send test** button. The backend round-trips through the live `SmtpTransport` using the saved settings and returns the actual SMTP response on error (connection refused, 550 recipient rejected, certificate chain problems, etc. — all surface verbatim). Successful sends show up in the deliveries table below within a second.

The button is disabled until SMTP is enabled in the saved config — trying to test against unsaved form state leads to confusion, so we force a save first.

### 3. Recent deliveries

Last 50 rows of the `email_deliveries` audit table, ordered newest first, with a status filter (All / Queued / Sent / Failed / Bounced / Suppressed) and a manual **Refresh** button. Each row shows creation timestamp, template key, recipient, subject, status pill, attempt count, and the last error (hover for full text).

This is the same data that powered the v0.25.0 `GET /api/admin/notifications/deliveries` endpoint — which had been observable only via `curl` before now.

---

## 🛠️ API layer

Four new typed helpers in [`frontend/src/api.ts`](frontend/src/api.ts):

```ts
getSmtpConfig(): Promise<SmtpConfig>
updateSmtpConfig(body: SmtpConfigUpdate): Promise<{ status: string }>
testSmtpSend(recipient: string): Promise<{ status: string }>
listEmailDeliveries(status?, limit?): Promise<EmailDelivery[]>
```

Full TypeScript types (`SmtpConfig`, `SmtpConfigUpdate`, `EmailDelivery`) are exported for callers outside the Notifications tab.

---

## 📦 Upgrade notes

- **Database migration** — none.
- **API contract** — no new, removed, or changed endpoints. The v0.25.0 routes are now driven by the admin UI instead of requiring `curl`.
- **Breaking changes** — none.
- **Version bump** — `VERSION`, `frontend/package.json` (+ lock), `backend/Cargo.toml` (+ lock), and the README badge now read **0.25.2**.

---

## 🙏 Credits

Thanks to the admin who noticed the discrepancy between the release notes and the actual UI. The v0.25.0 changelog entry has been annotated in v0.25.2's *Fixed* section as a documentation-honesty correction.

---

# What's New in v0.25.1

> **Quality-of-life patch release.** v0.25.1 lands a targeted RDP canvas-refresh fix for the "screen clipping" artefact that some users saw after minimising and restoring an active remote session, plus a zero-warning backend release build. No schema changes, no API contract changes, drop-in upgrade.

---

## 🖥️ RDP "screen clipping" fixed (with a new **Refresh display** button)

A subset of RDP users reported a stale rectangle of pixels remaining visible in the lower-right of the remote canvas after minimising and restoring the window (or toggling full-screen). The artefact would persist until the user manually resized the browser window, at which point the next draw cycle cleared it.

**Root cause.** Guacamole's JavaScript display emits a `display.onresize` event when the remote framebuffer changes size, but the browser compositor — with no CSS property change to invalidate its tile cache — would occasionally keep the pre-resize rectangle on screen if no pixel data arrived on the affected region before the next paint.

**The fix.** v0.25.1 introduces a `forceDisplayRepaint()` helper on `SessionClient.tsx` that nudges the canvas scale by a sub-pixel delta (`baseScale + 1e-4`), which the compositor treats as a transform change and which therefore invalidates every cached tile, forcing a full repaint of the `guacamole-common-js` display layers. The helper is:

1. **Auto-scheduled** at 50 ms, 200 ms, and 500 ms after every `display.onresize` event, so the common minimise/restore/full-screen-toggle cases self-heal with no user intervention.
2. **Exposed** through the session object as `refreshDisplay?: () => void` and surfaced in `SessionBar` as a **Refresh display** button, so users hitting rarer edge cases (GFX pipeline stalls, out-of-order H.264 frames on flaky networks) have a one-click recovery path.

The button only appears for sessions that publish `refreshDisplay` — historical recording playback is unaffected and does not show the control.

---

## 🧹 Zero-warning backend release build

The v0.25.0 notification pipeline landed with a public API surface sized for P8 (admin UI) and P9 (user opt-out UI) work that is still pending. Those reserved items generated 16 `unused_imports` / `dead_code` warnings during `docker compose build backend`.

v0.25.1 tidies the output: genuinely-unused imports are removed, and every retained-for-future-phase item (`InlineAttachment`, `BoxedTransport`, `SendError`, `StubTransport`, `describe`, `context_from_pairs`, the `reply_to`/`inline` builders, `DeliveryToRetry.attempts`, and `CheckoutEvent::target_account_dn`) now carries a focused `#[allow(dead_code)]` or `#[allow(unused_imports)]` annotation **with a rationale comment** pointing to the consuming phase. The outcome is a clean `cargo check --bin strata-backend --all-targets` — **0 warnings, 0 errors** — ready for an eventual `-D warnings` CI gate.

No runtime code was removed. All 852 backend unit tests pass unchanged.

---

## 📦 Upgrade notes

- **Database migration** — none. No schema change.
- **Breaking changes** — none. `GuacSession` gained an optional field (`refreshDisplay?: () => void`) used only by in-memory frontend code.
- **API contract** — unchanged; no new, removed, or renamed endpoints.
- **Version bump** — `VERSION`, `frontend/package.json`, `backend/Cargo.toml`, and `backend/Cargo.lock` now read **0.25.1**.

---

## 🙏 Credits

Thanks to the user who reported the RDP minimise/restore clipping; the repro steps (minimise → wait → restore, artefact persists until browser resize) were what identified the compositor-cache miss as the root cause rather than the originally-suspected canvas geometry bug.

---

# What's New in v0.25.0

> **Notifications release.** v0.25.0 delivers the long-awaited modern checkout-notification email pipeline — polished MJML templates, Outlook dark-mode hardening, an admin SMTP UI, per-user opt-outs, and a background retry worker. Zero-downtime upgrade; emails simply start flowing once an admin configures the SMTP relay.

---

## 📬 Modern managed-account notification emails

Strata now sends mobile-friendly HTML emails for every key managed-account checkout event:

| Event | Recipients | Opt-out? |
|---|---|---|
| **Checkout pending approval** | All assigned approvers for the target account | ✅ Yes |
| **Checkout approved** | The original requester | ✅ Yes |
| **Checkout rejected** | The original requester | ✅ Yes |
| **Self-approved checkout (audit notice)** | Configured audit recipients | ❌ No (audit visibility) |

Each email is rendered from an [MJML](https://mjml.io) template (mobile-responsive, tested across Gmail / Outlook / Apple Mail), dispatched as `multipart/related` with the Strata logo inlined as `cid:strata-logo`, and accompanied by a plain-text alternative for accessibility and minimal-client compatibility.

### 🌒 Outlook dark-mode "haze" fixed

Outlook desktop on Windows has a long-standing dark-mode quirk where it overlays a lighter rectangle ("haze") on top of HTML emails by inverting `bgcolor` attributes. v0.25.0 ships a reusable `wrap_for_outlook_dark_mode` helper that injects:

1. The VML namespace on `<html>`
2. A full-bleed `<v:background fill="t">` inside an `<!--[if gte mso 9]>` conditional
3. An Outlook-only stylesheet forcing dark backgrounds

VML backgrounds are immune to Outlook's inversion engine, so the result is a clean dark-themed email even in Outlook desktop dark mode. Future templates inherit the fix automatically.

---

## ⚙️ Admin SMTP configuration UI

A new **Admin → Notifications** tab exposes:

- **SMTP host / port / TLS mode** (`STARTTLS`, implicit-TLS, or plaintext for internal relays)
- **Username** (plaintext) and **password** (sealed into Vault — see security note below)
- **From-address** and **From-name**
- **Send test email** button — round-trips through the live transport and surfaces the actual SMTP response for debugging
- **Recent deliveries** view — last 50 attempts with status, attempt count, and error reason

### 🔐 Security note: SMTP password requires Vault

The SMTP password is **hard-required** to be stored in Vault. The `PUT /api/admin/notifications/smtp` endpoint refuses to save credentials if Vault is sealed or running in stub mode. This is intentional — SMTP credentials granting outbound mail are a high-value target and must never sit in plaintext on disk.

### 🚦 Dispatch is blocked when from-address is empty

If `smtp_from_address` is empty, the dispatcher silently skips all sends and audit-logs `notifications.misconfigured`. This prevents half-configured installs from queuing thousands of broken messages.

---

## 🙋 Per-user opt-outs (with audit trail)

v0.25.0 introduces a single `users.notifications_opt_out` boolean column. When set, the dispatcher suppresses **all** transactional messages for that user and records each suppression as a `notifications.skipped_opt_out` audit event with the template key and target entity ID. Every suppression is also reflected in the `email_deliveries` audit table with `status = 'suppressed'`.

Self-approved audit notices are intentionally **not opt-out-able** — they exist for security visibility, not user convenience. The dispatcher's `ignores_opt_out` branch is hard-coded to bypass the flag for the self-approved template.

> [!NOTE]
> The user-facing toggle UI ships in a follow-up release. For v0.25.0, administrators can set the flag directly via SQL (`UPDATE users SET notifications_opt_out = true WHERE id = $1`).

---

## 🔁 Background retry worker

Transient SMTP failures (network blips, 4xx responses, transient connection errors) are retried automatically by a new `email_retry_worker`:

- **Tick interval**: 30 seconds
- **Initial warm-up**: 60 seconds
- **Per-attempt timeout**: 120 seconds
- **Backoff**: exponential
- **Max attempts**: 3 — after which the row is marked `abandoned` and a `notifications.abandoned` audit event is emitted

**Permanent failures (5xx)** are *not* retried — they go straight to `failed` so admins can see the underlying SMTP rejection in the deliveries view.

---

## 🗄️ Schema additions (migration 055)

```
email_deliveries             — every send attempt with status, attempts, last_error
users.notifications_opt_out  — single boolean column for global per-user opt-out
system_settings (8 new rows) — smtp_enabled, smtp_host, smtp_port, smtp_username,
                                smtp_tls_mode, smtp_from_address, smtp_from_name,
                                branding_accent_color
```

The SMTP password is **not** stored in `system_settings`. It lives sealed under Vault Transit using the same `seal_setting` / `unseal_setting` helpers as `recordings_azure_access_key`. The `email_deliveries` table is indexed on `(status, created_at)` for the retry worker's selection query, on `(related_entity_type, related_entity_id)` for per-checkout lookups, and on `recipient_user_id` (partial, NOT NULL) for per-user audit views.

---

## 📈 Approver fan-out improvement

Previously, only the first matching approver received the *pending* notification. v0.25.0's `services::checkouts::approvers_for_account` now joins `approval_role_accounts` with `approval_role_assignments` to fan out to **every assigned approver** for the target account. No configuration change required.

---

## 🚀 Upgrade notes

- **Database migration** runs automatically on first boot of v0.25.0 (`055_notifications.sql`).
- **No emails will be sent** until an admin visits **Admin → Notifications**, configures SMTP, and saves a `from-address`. This is intentional — silent dispatch on an unconfigured relay would be worse than no dispatch at all.
- **Existing admins** see no behaviour change for non-notification flows. The dispatcher is fire-and-forget and never blocks the user-facing checkout request.
- **Per-user opt-outs default to "send"** for all opt-out-able events. Users wishing to mute notifications must visit **Profile → Notifications** after the upgrade.

---

## 🛠️ Under the hood

- **Migration**: [`backend/migrations/055_notifications.sql`](backend/migrations/055_notifications.sql) — adds `email_deliveries`, the `users.notifications_opt_out` column, and 8 SMTP/branding rows in `system_settings`.
- **Module layout**: `backend/src/services/email/` houses the trait (`transport.rs`), production transport (`smtp.rs`), MJML renderer (`templates.rs` + `templates/`), Outlook VML wrapper (`outlook.rs`), and retry worker (`worker.rs`). Dispatcher lives in `backend/src/services/notifications.rs`.
- **New crates**: `lettre 0.11` (rustls + tokio1), `mrml 5`, `tera 1`, `async-trait 0.1`. `ammonia` was *removed* in favour of a custom 5-character `xml_escape` helper.
- **ADR**: [ADR-0008 — Notification pipeline](docs/adr/ADR-0008-notification-pipeline.md) records the design rationale (MJML + mrml, Vault-sealed password, opt-out semantics, retry strategy, alternatives considered).
- **Runbook**: [docs/runbooks/smtp-troubleshooting.md](docs/runbooks/smtp-troubleshooting.md) covers symptom triage, log inspection, common transient/permanent errors, and rollback.
- **Version bump**: `VERSION`, `frontend/package.json`, and `backend/Cargo.toml` all now read **0.25.0**.
- **Validation**: 852 / 852 backend tests pass (was 817 in v0.24.0); all 26 `services::email::*` tests green.

---

# What's New in v0.24.0

> **RBAC refinement release.** v0.24.0 introduces a dedicated permission for the in-session Quick Share feature and consolidates the two "create connections" permissions into a single, clearer flag. Zero-downtime, non-breaking upgrade for every existing role.

---

## 🔐 New permission: **Use Quick Share** (`can_use_quick_share`)

Quick Share — the ephemeral file CDN exposed on the Session Bar for handing files into a remote desktop — previously relied on implicit "if the button is visible, the user can use it" gating with no backend enforcement. In v0.24.0 it is a first-class role permission:

| Surface | Behaviour before v0.24.0 | Behaviour in v0.24.0 |
|---|---|---|
| **Session Bar button** | Always visible while a session was active | Visible only when the user's role grants `can_use_quick_share` (or `can_manage_system`) |
| **`POST /api/files/upload`** | Any authenticated user | Requires `can_use_quick_share`; returns `403 Forbidden` otherwise |
| **Admin role editor** | No checkbox | New **Use Quick Share** checkbox under **Admin → Access → Roles** |

> [!NOTE]
> **Upgrade behaviour is non-breaking.** Migration 054 sets `can_use_quick_share = true` on every existing role on first boot. Administrators who want to restrict Quick Share should untick the new checkbox on the relevant roles after the upgrade.

### Why a separate permission?

Quick Share writes to the backend file-store and is **independent of the guacd drive / SFTP channels** (which remain gated by the per-connection `enable-drive` / `enable-sftp` extras fixed in v0.23.1). That makes it a distinct capability from "Browse Files", and cleaner to govern separately — some tenants want to grant drive access but forbid link-sharing, or vice versa.

`can_use_quick_share` is treated as a **user-facing feature flag**, not an administrative permission. It is deliberately **excluded** from `has_any_admin_permission()`, so granting a role only Quick Share does **not** unlock any admin UI or endpoint. A dedicated regression test (`has_any_admin_perm_excludes_quick_share`) guards this invariant.

---

## 🧩 Unified "Create connections" permission

The role editor used to carry two almost-always-identical permissions:

- **Create new connections** (`can_create_connections`)
- **Create connection folders** (`can_create_connection_folders`)

In every review those two checkboxes ended up ticked together; the separation produced confusion more often than it produced value. v0.24.0 consolidates them:

- The `can_create_connection_folders` column is dropped from the `roles` table.
- Before dropping, migration 054 OR's its value **into** `can_create_connections`, so any role that had folders-only keeps connection-creation rights.
- The role-editor checkbox for "Create connection folders" is removed. Users with **Create new connections** can now create and organise both connections *and* their folder hierarchy.

> [!TIP]
> **No one loses a capability.** Roles that previously had only the folders flag are silently upgraded to full connection creation — consistent with the practical reality that folders are meaningless without connections to put in them.

---

## 📡 API surface changes

Every user / auth / role API now emits `can_use_quick_share` in place of `can_create_connection_folders`:

- `GET /api/user/me`
- `POST /api/auth/login` (response payload's `user` object)
- `GET /api/admin/roles`, `POST /api/admin/roles`, `PUT /api/admin/roles/:id`

External API consumers should update their field mappings. The JSON field **count and shape are preserved** — only the semantic meaning of the retired slot has changed. See [`docs/api-reference.md`](docs/api-reference.md) for the full updated schemas.

---

## 🛠️ Under the hood

- **Migration**: `backend/migrations/054_unify_connection_folder_perm_add_quick_share.sql` performs the OR-rollup and column swap in a single transaction.
- **New middleware helper**: `services::middleware::check_quick_share_permission(&AuthUser)` — reusable gate for any future Quick-Share-adjacent endpoint.
- **Frontend context**: `SessionManagerProvider` now exposes `canUseQuickShare: boolean`; `App.tsx` seeds it from the authenticated user.
- **Version bump**: `VERSION`, `frontend/package.json`, and `backend/Cargo.toml` all now read **0.24.0**.
- **Validation**: 1,165 / 1,165 Vitest tests pass; backend `cargo check --all-targets` clean; TypeScript strict mode clean.

---

# What's New in v0.23.1

> **Maintenance release — zero user-facing changes.** v0.23.1 closes out the final front-end complexity item and retires the compliance tracker that has guided the last six waves of work.

---

## 🧱 `AdminSettings.tsx` is no longer a monolith

The Admin Settings page used to live in a single **8,402-line** React file. That file has been broken up into one module per tab under `frontend/src/pages/admin/`:

| Tab | Module |
|---|---|
| Health · Display · Network · SSO · Kerberos · Recordings · Vault · Access · Tags · AD Sync · Password Mgmt · Sessions · Security | one file each under `frontend/src/pages/admin/` |
| Connection-form helpers (`Section`, `FieldGrid`, `RdpSections`, `SshSections`, `VncSections`) | `admin/connectionForm.tsx` |
| Shared RDP keyboard layouts | `admin/rdpKeyboardLayouts.ts` |

`AdminSettings.tsx` itself is now a **258-line** dispatcher that loads settings once and renders the currently-selected tab. Net reduction across the admin surface: **−8,144 lines**. No behavioural changes; **1,162 / 1,162 frontend tests pass** and the backend suite is green.

### Why you care (even though nothing looks different)

- **Faster reviews**: each tab is now reviewed and tested in isolation.
- **Smaller edits**: touching the Vault tab no longer churns the whole file.
- **Lower recompile cost**: Vite HMR only reloads the affected tab.
- **Easier onboarding**: the admin surface is now self-documenting via its directory layout.

---

## 🗂️ Compliance tracker retired — 62 / 62 items closed

`docs/compliance-tracker.md` has been deleted. Every item across W0 – W5 is complete, and the artefacts that the tracker produced live on in their proper homes:

- **Seven ADRs** under `docs/adr/` (rate limiting, CSRF, feature flags, guacd model, JWT/refresh, Vault envelope, emergency bypass).
- **Five runbooks** under `docs/runbooks/` (disaster recovery, security incident, certificate rotation, vault operations, database operations).
- **Architecture baseline** captured in `docs/adrs/0001-architecture-baseline.md`.

Live references to the tracker (PR template, runbook index, ADR-0001) have been updated. Historical mentions in `CHANGELOG.md` and earlier `WHATSNEW.md` sections are preserved as point-in-time records.

---

## 🛠️ Under the hood

- No migrations, no config changes, no service restart semantics.
- Version bumped: `VERSION`, `frontend/package.json`, `backend/Cargo.toml` all now read **0.23.1**.
- Rust 1.95 / React 19 / TypeScript 6 toolchain from 0.23.0 is unchanged.

---



> **Compliance & operations release.** No feature-facing changes for end users — v0.22.0 closes out the data-retention and operational-documentation items from the compliance tracker so administrators and on-call engineers have runtime-configurable retention windows, concrete runbooks, and a documented design record.

---

## 🗑️ Recording retention now actually deletes

The scheduled recordings worker previously enforced `recordings_retention_days` only against **local files** in the recordings volume. Database rows and Azure Blob artefacts were left behind, so retention was partial and blob storage grew unbounded.

As of v0.22.0, every sync pass:

1. Selects every `recordings` row older than the configured window.
2. Deletes the underlying artefact — Azure blob via the Transit-sealed storage account key, or local file from the recordings volume.
3. Deletes the database row.

Each pass logs `purged_azure`, `purged_local`, and `deleted_rows` totals for auditability.

---

## 👤 User hard-delete window is now configurable

Soft-deleted users previously became unrecoverable after a **hardcoded 7 days**. That window was below many regulatory norms and could not be widened without a code change.

As of v0.22.0 the window defaults to **90 days** and is editable by an administrator in the Admin Settings → **Security** tab → **Data Retention** section. Valid range is **1 to 3650 days**. The setting (`user_hard_delete_days`) is applied by the background cleanup worker via parameter-bound `make_interval(days => $1)` — no SQL interpolation, no downtime to change.

> [!TIP]
> Shortening the window does not immediately delete existing soft-deleted users — it simply means the next worker pass will consider any row whose `deleted_at` is older than the new window.

---

## 📚 Architecture Decision Records — now written down

Five new ADRs capture decisions that were previously only in operator heads:

| ADR | Topic |
|---|---|
| **ADR-0003** | Feature flags — why we kept boolean settings and when we'd promote to a real flag table |
| **ADR-0004** | guacd connection model, protocol-parameter allow-list, and trust boundaries |
| **ADR-0005** | JWT + refresh-token TTLs, single-use refresh rotation, global-logout lever |
| **ADR-0006** | Vault Transit envelope format (`vault:<base64>`), rotate + rewrap path |
| **ADR-0007** | Emergency approval bypass & scheduled-start checkouts — data model and audit invariants |

All live under `docs/adr/`.

---

## 📘 On-call runbooks — copy-pasteable, not prose

Five step-by-step runbooks were added under `docs/runbooks/`:

- **Disaster Recovery** — RTO ≤ 4h / RPO ≤ 24h, full restore sequence including Vault unseal and DNS cutover.
- **Security Incident Response** — SEV-1 containment in minutes, forensic SQL, remediation by incident class, post-incident cadence.
- **Certificate Rotation** — ACME and internal-CA paths side by side, with rollback.
- **Vault Operations** — unseal procedure, Transit key rotate + rewrap, and Shamir rekey for operator rotation.
- **Database Operations** — streaming-replica failover, compensating-migration pattern, and panic-boot recovery.

Each runbook follows a fixed template (Purpose → When to use → Prerequisites → Safety checks → Procedure → Verification → Rollback → Related).

---

## 🧭 Compliance tracker: Wave 5 closed

`docs/compliance-tracker.md` now shows **59 of 62** items done (up from 46). Every Wave 5 item — the three scheduled-job tasks, the feature-flags ADR, the four engineering ADRs, and the five runbooks — is ticked. The three remaining open items are deferred Wave 4 refactor tasks (`W4-4`, `W4-5`, `W4-6`) with no functional impact; they're tracked for a dedicated follow-up.

---

## 🛠️ Under the hood

- **Configurable retention windows** are bound via `make_interval(days => $1)` in every retention query path — no string concatenation of interval values anywhere.
- **No schema changes**, no migrations, no restart-required settings. Everything in this release is driven by existing `settings`-table keys or new static files.

---

# What's New in v0.20.2

> **v0.20.2 policy change**: Checkouts that go through an approver chain now **require a justification of at least 10 characters** (previously only Emergency Bypass required one). Approvers always see a written business reason before deciding. Self-approving users are unaffected — their comments remain optional.

---

# What's New in v0.20.1

> **v0.20.1 safeguard**: Emergency Approval Bypass checkouts are now hard-capped at **30 minutes**, regardless of the duration submitted. The duration input caps to 30 automatically when the ⚡ Emergency Bypass checkbox is ticked, and the backend enforces the same ceiling server-side. This tightens the exposure window for credentials released without approver review.

---

## 🕒 Schedule a Future Password Release

You can now request a password checkout that releases at a future moment instead of right now — perfect for change windows, planned maintenance, or passing a privileged credential to a colleague for a scheduled task.

### How to use it

1. Open the **Credentials** tab and start a new checkout request for a managed account.
2. Tick **"Schedule release for a future time"**.
3. Pick a date and time between **1 minute from now** and **14 days** in the future.
4. Submit. The checkout sits in the new **Scheduled** state — no password exists yet — and the Credentials card shows "🕒 Release scheduled for …".
5. When the scheduled time arrives, the backend automatically generates the password, resets it in Active Directory, and seals it in Vault. The checkout card flips to **Active** and you can reveal it exactly as usual.

> [!TIP]
> Scheduled checkouts count toward the "one open request per account" guard, so you cannot accidentally queue two overlapping releases.

---

## ⚡ Emergency Approval Bypass (Break-Glass)

When a production incident needs a privileged credential *right now* and the approver chain is unavailable, admins can let users self-release with a mandatory written justification.

### How it works

- An administrator enables **"Emergency Approval Bypass (Break-Glass)"** inside an **AD Sync → Password Management** configuration.
- When the option is on, approval-required users see an **⚡ Emergency Bypass** checkbox on the checkout form.
- Enabling bypass requires a justification of at least **10 characters**, is **capped at 30 minutes** (the duration input is limited and any longer value submitted is clamped server-side), and skips the approver chain — the checkout activates immediately, just like a self-approved request.
- Every emergency checkout is flagged, badged with **⚡ Emergency** across the Credentials and Approvals views, and recorded in the audit log as `checkout.emergency_bypass` so the event can be reviewed after the fact.

> [!IMPORTANT]
> Break-glass is hidden on the form when you're scheduling a future release — the two options are mutually exclusive. Emergency = immediate, Scheduled = future.

---

## 🛠️ Additional Technical Updates

- **Migration 051**: Adds `pm_allow_emergency_bypass` to AD sync configs and `emergency_bypass` to checkout requests.
- **Migration 052**: Adds `scheduled_start_at` to checkout requests and introduces the `Scheduled` state (full state set: Pending, Approved, Scheduled, Active, Expired, Denied, CheckedIn). Partial index on `scheduled_start_at` keeps the worker's due-scan fast.
- **Single Expiration Worker**: The existing 60-second checkout worker now also activates due scheduled checkouts — no extra background processes.

---
*For a full technical list of changes, please refer to the [CHANGELOG.md](file:///c:/GitRepos/strata-client/CHANGELOG.md).*
