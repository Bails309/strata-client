# ADR-0001 — Rate-limit distributed-state strategy

- **Status**: Accepted
- **Date**: 2026-04-21
- **Wave**: W3-8
- **Related standards**: §14.3, §3.3
- **Supersedes**: —
- **Superseded by**: —

## Context

Coding Standards §14.3 calls for request-rate limits on authentication,
password-reset, and other abuse-prone endpoints. The current
implementation (see `backend/src/routes/auth.rs` and
`backend/src/routes/admin.rs`) uses **in-process sliding-window
`HashMap<key, Vec<Instant>>` counters** guarded by a `std::sync::Mutex`.

This has two obvious consequences in a multi-replica deployment:

1. An attacker who targets replica A, replica B, replica C in round-robin
   gets `N × buckets` of effective capacity — our production deployment
   typically runs 3 replicas behind nginx, so a 5-attempts/minute login
   rate limit becomes 15 attempts/minute per username.
2. Rate-limit state is lost on pod restart. The practical effect is
   identical to item 1 at rolling-deploy time.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| **A. Accept single-instance semantics** (current) | Zero new deps; zero new failure modes | Higher effective-capacity under horizontal scaling |
| **B. Redis-backed sliding window** (feature-flag) | Shared across replicas | New operational dependency; Redis outage must be a **soft-fail** (allow the request) or **hard-fail** (deny everything) — both wrong |
| **C. Session affinity on rate-limited routes** | No new infra | Breaks on LB config drift; accidental sticky-to-dead-pod storm |
| **D. PostgreSQL row-level rate limit** | Infra we already have | Per-request DB hit on every login — expensive at scale |

## Decision

**Accept option A for the current major release.** The threat model that
motivates §14.3 is credential stuffing and user-enumeration, both of
which our existing limiter + constant-time user-enumeration defence in
`routes/auth.rs::login` already make expensive enough that a 3× boost
from replica fan-out does not meaningfully lower the attacker's bar.

Promote to option B (Redis-backed, feature-flag `STRATA_REDIS_URL`)
only when either:

* we horizontally scale past **5 replicas**, *or*
* SOC-monitoring surfaces a credential-stuffing wave that successfully
  exploits the fan-out gap, *or*
* a customer specifically requires distributed rate limiting as a
  procurement condition.

Until then, every place we add a rate limit (e.g. W3-7's per-admin
password-reset throttle) uses the same `check_rate_limit` helper from
`routes/auth.rs` so the migration to Redis is a one-shot search-and-
replace when the trigger fires.

## Consequences

**Positive**

* No Redis dependency today; single-node deployments are trivially
  secure.
* Every rate-limited route uses a single code path, making the future
  Redis migration a bounded refactor.
* Limits that are self-damping (an attacker who blows one bucket on
  replica A is still subject to the limits on replicas B and C **per
  attempt**) are recorded as WAF input via the `reset_user_password`
  audit log, so the effective attacker cost stays bounded.

**Negative**

* Effective capacity scales with replica count. Documented in
  `docs/deployment.md §Rate limits` (TODO in W5 runbook sweep).
* A replica reboot resets the counters for that replica's share of the
  traffic. Acceptable under the threat model above; unacceptable under
  a dedicated credential-stuffing adversary, which would trigger the
  promotion criteria above.

## Implementation notes

* Each limiter is gated by `MAX_RATE_LIMIT_ENTRIES` / `RESET_PW_MAX_ENTRIES`
  to prevent OOM under enumeration attacks.
* The Redis-backed adapter, when introduced, lives behind the cargo
  feature `redis-ratelimit` so the default build stays dependency-free.
* `check_rate_limit` already prunes on overflow, so neither the in-memory
  nor the Redis variant leaks memory on pathological input.

## Links

* `backend/src/routes/auth.rs::check_rate_limit`
* `backend/src/routes/admin.rs::reset_user_password`
* Coding Standards §14.3
