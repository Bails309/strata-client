# ADR-0002 — CSRF protection strategy: SameSite=Strict as compensating control

- **Status**: Accepted
- **Date**: 2026-04-21
- **Wave**: W3-9
- **Related standards**: §4.4
- **Supersedes**: —
- **Superseded by**: —

## Context

Coding Standards §4.4 requires CSRF protection on any state-changing
request that is authenticated via a cookie. The canonical implementation
is a double-submit token (synchroniser token mirrored in a header), but
that pattern has a non-trivial cost on the front-end:

* The token must be threaded into every fetch wrapper.
* Rotating the token (e.g. after login) must not break in-flight tabs.
* SSR pages must bake the token into the initial HTML payload.

Our threat model is narrower than the canonical one because **every
cookie we set is already `SameSite=Strict`** (see
`backend/src/routes/auth.rs::make_session_cookie`). A cross-origin
POST — the pre-requisite of a classical CSRF — cannot carry that cookie
at all, so the attacker's request arrives at the backend without a
session and is rejected by `require_auth` before the handler runs.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| **A. Double-submit CSRF token** | Industry-standard; works even if `SameSite=Strict` is loosened in future | Front-end complexity; must survive login/refresh; harder to get right on SSR |
| **B. SameSite=Strict only** (current) | Zero extra machinery; impossible to bypass without a same-site XSS | Regresses to vulnerable if a future dev loosens the cookie to `Lax` |
| **C. SameSite=Strict + per-request `Origin` / `Referer` check** | Defence in depth; catches `Lax` regression | `Origin` is absent on some legitimate navigations; tuning produces false positives |

## Decision

**Accept option B, with an invariant test that prevents regression.**

The session cookie MUST stay `SameSite=Strict` AND the equivalent
refresh-token cookie MUST stay `SameSite=Strict`. Any code change that
weakens either attribute — even to `Lax` — is treated as an ADR
revision, not a configuration tweak. This means:

1. `make_session_cookie` and `make_refresh_cookie` carry inline comments
   citing this ADR.
2. A unit test (`backend/src/routes/auth.rs`) asserts the literal
   string `SameSite=Strict` in the cookie header.
3. CI blocks a PR that deletes or loosens the assertion.

If the product ever needs cross-origin flows (e.g. an embedded widget
on a customer portal), this ADR is explicitly superseded by a new ADR
introducing a double-submit token; until then, the simpler model wins.

## Consequences

**Positive**

* No runtime CSRF middleware, no token plumbing in the frontend.
* `SameSite=Strict` also blocks the "top-level navigation" CSRF variant
  that `Lax` still allows (POST-via-form-in-iframe), so we close both
  classes with a single flag.
* Keeps our attack surface small: the only way to bypass is a same-
  origin XSS, which §4.1 (CSP, input validation) already targets.

**Negative**

* A developer who changes the cookie to `Lax` for any reason (e.g. to
  support an OIDC IdP flow that 303-redirects back in a top-level nav)
  would silently open a CSRF hole. Mitigated by the pinned unit test.
* Cookie-less API clients (machine tokens) are unaffected — they send
  `Authorization: Bearer ...` and are not subject to the browser's
  cookie rules — but they also cannot be CSRF'd, so this is fine.

## Implementation notes

* See `backend/src/routes/auth.rs::make_session_cookie` for the cookie
  builder.
* The `SameSite=Strict` assertion lives in
  `tests::session_cookie_is_strict` (add if not yet present).
* The OIDC `sso/callback` flow is a GET, so top-level-nav semantics
  apply without ever needing `Lax`.

## Links

* OWASP CSRF Cheat Sheet — §SameSite cookies
* RFC 6265bis — `SameSite=Strict` semantics
* Coding Standards §4.4
