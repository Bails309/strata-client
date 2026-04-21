# ADR-0003 — Feature flags: defer dedicated table, keep boolean settings

- **Status**: Accepted
- **Date**: 2026-04-21
- **Wave**: W5-4
- **Related standards**: §23 (feature management)
- **Supersedes**: —
- **Superseded by**: —

## Context

Coding Standards §23 calls for a feature-flag system that supports
gradual rollout (`rollout_pct`), timed activation (`enabled_at`), and
timed expiry (`expires_at`). The canonical shape is a dedicated
`feature_flags` table queried through a caching layer.

Strata already has a generic `settings` table (key/value, audited)
which today carries a handful of boolean flags:

* `recordings_enabled`
* `watermark_enabled`
* `sso_enabled`
* `local_auth_enabled`
* `dns_enabled`
* `pm_enabled` (per ad_sync config)

All of them are **binary, global, and operator-controlled**: an admin
toggles them in the UI, the backend reads the setting at request time,
and there is no user-cohort targeting, no time-boxed rollout, and no
per-request experiment bucketing.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| **A. Introduce `feature_flags` table now** | Matches §23 literally; ready for gradual rollouts | Zero call sites need rollout_pct today; migration + UI + cache tier is non-trivial; YAGNI |
| **B. Keep boolean settings, document design** (chosen) | Minimal code; ships today; every existing flag already fits | If we later need `rollout_pct`, we must refactor call sites |
| **C. Hybrid — keep settings, add `feature_flags` only for new experiments** | Forward-compatible | Two sources of truth; cognitive load |

## Decision

**Accept option B.** The existing `settings` table is the feature-flag
mechanism for operator toggles. A dedicated `feature_flags` table is
not introduced until a concrete call site needs at least one of:

1. **Percentage rollout** — enabling a flag for N% of users, not all
   or none.
2. **Scheduled activation** — flipping on at a specific UTC time
   without an operator present.
3. **Automatic expiry** — flag turns itself off at `expires_at` to
   prevent zombie toggles.
4. **Per-user / per-role targeting** that cannot be modelled as a
   role permission.

Until any of those criteria are met, new binary toggles are added as
settings keys with a documented default.

### Conventions for settings-as-flags

* Key format: `<area>_enabled` for booleans (e.g. `watermark_enabled`).
* Value: the literal strings `"true"` / `"false"`; readers MUST
  default to the safe side if the key is missing.
* Sensitive or security-invariant flags (e.g. `local_auth_enabled`,
  `sso_enabled`) go through `RESTRICTED_SETTINGS` in
  [backend/src/routes/admin.rs](backend/src/routes/admin.rs) and a
  dedicated endpoint with validation — not the generic
  `updateSettings` path.
* Every new flag must be audited via the same `settings::set` path
  (emits an audit log entry).

## Consequences

**Positive**

* No migration, no new table, no cache invalidation strategy to own.
* One endpoint (`GET /api/admin/settings`) surfaces every flag for
  the admin UI.
* Tests can stub a flag by inserting a row into `settings`.

**Negative**

* The moment one feature genuinely needs percentage rollout, this ADR
  is superseded by a new one introducing `feature_flags` plus a
  targeting evaluator. That refactor will touch the feature's call
  sites but not the unrelated boolean flags.
* No built-in expiry means a flag can live forever. Mitigation: the
  W5-5 disaster-recovery runbook includes a periodic review of
  `settings` keys as part of the quarterly ops review.

## Implementation notes

* Readers: `crate::services::settings::get(&pool, key).await?`
  returns `Option<String>`; callers parse with `.as_deref() ==
  Some("true")`.
* Writers: `crate::services::settings::set(&pool, key, value).await?`
  is audited automatically.
* UI: flags appear in [frontend/src/pages/AdminSettings.tsx](frontend/src/pages/AdminSettings.tsx),
  grouped by tab.

## Promotion criteria

Open a follow-up ADR introducing a `feature_flags` table when **any**
of the following land in the backlog:

1. An A/B experiment that measures outcomes by cohort.
2. A regulatory kill-switch that must auto-expire (e.g. a jurisdiction
   opt-out that is guaranteed to lift on a known date).
3. More than ~15 boolean toggles in `settings`, at which point a
   typed, self-documenting registry beats string keys.
