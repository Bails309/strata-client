# What's New in v0.22.0

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
