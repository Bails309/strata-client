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
