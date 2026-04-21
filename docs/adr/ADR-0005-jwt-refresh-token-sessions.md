# ADR-0005 — JWT + refresh-token session design and rotation rules

- **Status**: Accepted
- **Date**: 2026-04-21
- **Wave**: W5-11
- **Related standards**: §4.2 (session management), §4.4 (CSRF), §4.7 (token revocation)
- **Supersedes**: —
- **Superseded by**: —

## Context

Strata issues two tokens on login:

* **Access token** — short-lived JWT (RS256), sent as
  `Authorization: Bearer ...` on every API call **and** mirrored in
  an `HttpOnly; Secure; SameSite=Strict` cookie for the browser.
* **Refresh token** — longer-lived JWT, set as a separate
  `HttpOnly; Secure; SameSite=Strict` cookie scoped to
  `Path=/api/auth/refresh`.

Coding Standards §4.2 requires:

1. Short access-token lifetime with silent refresh.
2. Refresh-token rotation on every use (no replay).
3. A revocation path that takes effect before the next access token
   expires.
4. Path-scoped cookies so that the refresh token is never sent on
   ordinary API calls.

The concrete TTLs were chosen to balance UX (how often the user sees
a forced login) with blast radius (how long a leaked access token is
useful).

## Decision

**Accept the current two-token scheme with the following parameters
and rules.**

### Token TTLs

| Token | TTL | Source of truth |
|---|---|---|
| Access | **1200 s (20 min)** | `ACCESS_TOKEN_TTL` in [backend/src/routes/auth.rs](backend/src/routes/auth.rs) |
| Refresh | **28 800 s (8 h)** | `REFRESH_TOKEN_TTL` in [backend/src/routes/auth.rs](backend/src/routes/auth.rs) |

The 8-hour refresh TTL caps an **idle session** at 8 hours and an
**absolute session** at 8 hours because refresh rotation (below)
does not extend the absolute window beyond the original issuance
unless the user explicitly re-authenticates.

### Refresh rotation

`POST /api/auth/refresh`:

1. Reads the `refresh_token` cookie.
2. Validates signature, `iss`, `aud`, `exp`, and the `jti` against
   the revocation set.
3. Issues a **new** access token and a **new** refresh token.
4. Revokes the old refresh token by inserting its `jti` and `exp`
   into `revoked_tokens` (§4.7) and into the in-memory
   `token_revocation` set for hot-path checks.
5. Returns the new access token in the body and the new refresh
   token in a `Set-Cookie` header that replaces the old one.

A refresh token is therefore **single-use**: the moment it is
exchanged, the previous value is dead. Reuse (stolen-token replay)
is detected when the revoked `jti` is presented again and produces a
401 plus a security audit-log entry.

### Revocation

* `POST /api/auth/logout` revokes the current refresh token's `jti`,
  which prevents the browser (or a thief) from exchanging it for a
  new access token.
* Access tokens are **not** individually revocable — their short TTL
  is the blast-radius control. Forced global logout (e.g. after a
  password change) is implemented by bumping a per-user
  `sessions_valid_after` timestamp that the JWT validator checks
  alongside `exp`.
* Revocation state lives in both an in-memory set (hot path, zero
  RTT) and the `revoked_tokens` table (durable, survives restart and
  horizontal scale-out seed).

### Cookie attributes

* Access cookie: `HttpOnly; Secure; SameSite=Strict; Path=/`.
* Refresh cookie: `HttpOnly; Secure; SameSite=Strict;
  Path=/api/auth/refresh`.

The `Path=/api/auth/refresh` scope means the refresh token is not
sent on any endpoint other than the refresh handler, minimising its
exposure in proxy logs and request mirrors. `SameSite=Strict` is
load-bearing for CSRF — see [ADR-0002](ADR-0002-csrf-samesite-strict.md).

### JWT claims

| Claim | Meaning |
|---|---|
| `iss` | Strata instance URL, pinned per deployment |
| `aud` | `"strata-client"` |
| `sub` | User UUID |
| `jti` | Random v4 UUID used for revocation |
| `exp` | Unix timestamp |
| `iat` | Unix timestamp |
| `typ` | `"access"` or `"refresh"` |

Validator enforces `typ == "access"` on all protected endpoints so a
refresh token presented as a bearer cannot impersonate an access
token.

## Consequences

**Positive**

* 20-minute access-token blast radius: a leaked token is useful for
  at most one rotation cycle.
* Single-use refresh token detects replay and triggers alert logs.
* `HttpOnly` + path-scoping prevents JS XSS from exfiltrating the
  refresh token (it is not visible to any non-refresh endpoint).
* Symmetric revocation path across restart and multi-instance setups.

**Negative**

* Every 20 minutes the frontend must silently refresh. A flaky
  network can surface this as a user-visible hiccup; the
  frontend's `request()` wrapper retries once on 401 after calling
  the refresh endpoint.
* Revocation table grows over time. The W3-series cleanup job
  purges entries whose `exp` has already passed, so the table size
  is bounded by active-session count × refresh-rotation-frequency.
* Cannot force-kill a single access token mid-window; operators
  must use the per-user `sessions_valid_after` lever for incident
  response.

## Operational notes

* Key material: RS256 keypair in Vault; rotation via ADR-0006
  envelope pattern. Rotating the signing key invalidates all
  outstanding tokens (both access and refresh), which is the
  nuclear "global logout" path.
* Monitoring: a spike in 401s from the refresh endpoint with a
  known-revoked `jti` is the canonical signal of token theft.
