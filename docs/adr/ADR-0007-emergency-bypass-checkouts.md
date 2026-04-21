# ADR-0007 — Emergency approval bypass & scheduled-start checkout design

- **Status**: Accepted
- **Date**: 2026-04-21
- **Wave**: W5-13
- **Related standards**: §4.8 (break-glass access), §11 (approval workflow), §26 (audit)
- **Supersedes**: —
- **Superseded by**: —

## Context

Privileged-account checkouts normally require approval from a second
operator before the requestor can use the credential. Two scenarios
break this pattern:

1. **Scheduled change windows** — a checkout is requested during
   business hours for a change that executes at 02:00 UTC. The
   approver wants to approve now, but the credential must not be
   live until the scheduled window begins.
2. **Emergency / break-glass** — production is down, the on-call
   engineer needs the credential *now*, and no approver is
   available. Standards §4.8 requires a bypass path that is
   auditable and rare.

Both cases need to be first-class in the data model so they can be
reported on, alerted on, and audited without relying on operator
discipline.

## Decision

**Accept the following model in `checkouts` (and the surrounding
approval plumbing) for scheduled-start and emergency-bypass flows.**

### Schema fields (relevant subset)

| Column | Purpose |
|---|---|
| `emergency_bypass` (bool, default false) | Marks the checkout as break-glass |
| `scheduled_start_at` (timestamptz, nullable) | If set, the credential is inert until this time |
| `approved_at`, `approver_user_id` | Normal approval path |
| `expires_at` | Hard cap on credential validity |
| `pm_allow_emergency_bypass` (on `ad_sync_configs`) | Per-scope opt-in |

### Scheduled-start semantics

* A checkout with `scheduled_start_at IS NOT NULL AND
  scheduled_start_at > now()` is considered **pending activation**,
  even if `approved_at` is set.
* The credential-issue endpoint returns 409 `Conflict` with a
  `not_yet_active` code until `scheduled_start_at <= now()`.
* A background worker (same harness as W5-1/W5-2) transitions
  pending-activation rows to active at their scheduled time; the
  `checkouts` SELECT at
  [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs)
  filters on `scheduled_start_at IS NOT NULL AND scheduled_start_at
  <= now()` so the activation is idempotent.
* Approval is required **before** `scheduled_start_at` can take
  effect, except when `emergency_bypass = true`.

### Emergency-bypass semantics

Emergency bypass is permitted only when **all** of the following hold:

1. The target scope has `pm_allow_emergency_bypass = true` at the
   `ad_sync_configs` level (explicit opt-in by an admin — there is
   no tenant-wide "always allow" switch).
2. The requesting user has the role permission to request bypass
   (separate from the permission to request normal checkouts).
3. The request payload sets `emergency_bypass = true`.

When accepted, the checkout:

* Is created as `approved_at = now()` and `approver_user_id =
  requesting_user_id`, with `emergency_bypass = true`.
* Has a shortened `expires_at` (typically 1 hour vs. the normal
  default) — operators must justify extensions through a normal
  approval.
* Emits a **high-severity audit event** (`pm.checkout.emergency`)
  that is tagged for SIEM export.
* Is surfaced in the admin UI with a distinct visual treatment and
  in a dedicated metric so that ops can trend bypass frequency.

### Audit invariants

* Every bypass row has at least one audit event.
* Periodic review of bypass rows is an operational runbook item
  (W5-6 — security-incident runbook).
* Bypass cannot be silently disabled for a scope; toggling
  `pm_allow_emergency_bypass` is itself an audited settings write.

## Consequences

**Positive**

* Scheduled changes can be pre-approved at convenient times without
  giving the requestor live credentials before the window.
* Break-glass is explicit, scoped, and time-limited — not an
  unlogged operator override.
* Abuse is visible: the `pm.checkout.emergency` metric and audit
  event stream give ops and security a single pane of glass for
  review.

**Negative**

* Bypass is a real code path and must stay exercised by tests.
  Regression risk is mitigated by explicit integration tests in
  `backend/src/services/checkouts.rs` that cover both the happy path
  and the "scope does not allow bypass" rejection.
* A malicious admin with permission to flip
  `pm_allow_emergency_bypass` can widen the blast radius. This is
  accepted because the same admin could also create a new
  privileged account outright; the control boundary is the set of
  users with admin rights, not bypass specifically.
* Scheduled-start requires a background activation worker; if that
  worker is down, activation is delayed but never incorrect (the
  `scheduled_start_at <= now()` filter is idempotent).

## Implementation notes

* Data model: `emergency_bypass` and `scheduled_start_at` on
  `checkouts` (see
  [backend/src/services/checkouts.rs](backend/src/services/checkouts.rs)).
* Scope opt-in: `pm_allow_emergency_bypass` on `ad_sync_configs`
  (see [backend/src/routes/admin.rs](backend/src/routes/admin.rs)).
* Activation query: `WHERE scheduled_start_at IS NOT NULL AND
  scheduled_start_at <= now()` in `checkouts.rs`.
* Audit event name: `pm.checkout.emergency` with full request
  context (user, scope, justification text, target account).
* Metric: counter `pm_checkout_emergency_total{scope=...}`.

## Review cadence

Bypass rows are reviewed weekly per the security-incident runbook
(W5-6). A bypass rate that trends up without a corresponding
incident report is itself a signal and is treated as a finding.
