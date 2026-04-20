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
