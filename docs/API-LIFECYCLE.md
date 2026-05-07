# API Lifecycle & Versioning Policy

This document defines the support window, deprecation, and breaking-change
policy for the Strata HTTP API. It is the contract operators and
integrators rely on when pinning to a specific Strata release.

## Versioning model

Strata API endpoints are organised under a major-version URL prefix:

```
/api/v1/...
```

* The **major version** changes only on a backwards-incompatible change.
* Backwards-compatible additions (new endpoints, new optional fields,
  new enum variants tolerated by `unknown` defaults) are made in place
  inside the current major version.
* Endpoints that pre-date the `/api/v1` prefix and are still served at
  `/api/...` (without a version segment) are considered **v1** and are
  covered by the same policy. They will be aliased under `/api/v1/...`
  during the v1 → v2 cutover and removed only after the v1 EOL date.

Experimental endpoints live under `/api/v1/experimental/...`. They have
**no stability guarantees** and may change or disappear in any release.
They are excluded from this policy.

## Support window

| Major version | Status                | First release | EOL                    |
|---------------|-----------------------|---------------|------------------------|
| v1            | Current (supported)   | 1.0.0         | TBA — superseded by v2 |
| v2            | Not yet released      | —             | —                      |

* The **Current** major version receives bug fixes, security fixes, and
  additive changes in every release.
* The **Previous** major version (once v2 ships) is supported for a
  minimum of **two minor releases** of the Current version, or
  **6 months**, whichever is longer.
* Versions older than the Previous version are unsupported. They will
  return `410 Gone` once removed.

## Breaking changes

A change is considered breaking if any of the following are true:

* An endpoint is removed or renamed.
* A required request field is added.
* A response field is removed, renamed, retyped, or moved between
  objects.
* A response field's semantics change (e.g. unit changes from `seconds`
  to `milliseconds`).
* An HTTP status code or error-code value for a documented failure mode
  changes.
* Authentication, authorisation, or rate-limit behaviour becomes more
  restrictive in a way that an existing well-formed request begins to
  fail.

Breaking changes ship **only** in a new major version. They are not
made in place in the Current version. The single exception is a
security fix that cannot be carried out additively, which will be
called out in the [CHANGELOG](../CHANGELOG.md) under a `BREAKING SECURITY`
heading.

## Non-breaking changes

These are made in place in the Current major version and announced in
[CHANGELOG](../CHANGELOG.md):

* Adding a new endpoint.
* Adding a new optional request field.
* Adding a new response field.
* Relaxing a validation rule.
* Adding a new enum variant **only when** the existing client contract
  documents that unknown variants must be tolerated. New enum variants
  on legacy fields are treated as breaking.

## Deprecation process

Endpoints and fields are deprecated for at least **two minor releases**
before removal in a new major version.

A deprecated endpoint:

1. Is annotated in [api-reference.md](api-reference.md) with a
   `Deprecated` notice that names the replacement.
2. Returns the following HTTP headers on every response:

   * `Deprecation: true` (RFC 9745)
   * `Sunset: <RFC 9110 IMF-fixdate>` — the planned removal date,
     never less than 90 days from the release that introduced the
     deprecation header.
   * `Link: <replacement-url>; rel="alternate"` — when a one-to-one
     replacement exists.

3. Continues to function unchanged until the Sunset date.
4. Is announced in [CHANGELOG](../CHANGELOG.md) under a `Deprecated`
   subsection of the release that introduced the headers, and again in
   the release that removes it.

After the Sunset date and after the next major version ships, the
endpoint returns `410 Gone` with a JSON body:

```json
{
  "error": "endpoint_removed",
  "code": "E_GONE",
  "message": "GET /api/v1/old-thing was removed in v2.0; use GET /api/v2/new-thing"
}
```

## Error code stability

Strata returns a stable, machine-readable `code` field alongside the
human-readable `error` string in every error response (see
[backend/src/error.rs](../backend/src/error.rs)). Codes are part of the
API contract:

* New error codes may be added in any release.
* Existing error codes will not change meaning within a major version.
* HTTP status codes for documented error codes will not change within
  a major version.

The full list of error codes is published in
[api-reference.md#error-codes](api-reference.md).

## Changelog discipline

Every PR that touches a public API path must update [CHANGELOG](../CHANGELOG.md)
with a one-line entry under the appropriate heading:

* `Added` — new endpoints, fields, codes.
* `Changed` — non-breaking semantic changes (e.g. new optional default).
* `Deprecated` — endpoints and fields that have entered the deprecation
  window. Must include the planned Sunset date.
* `Removed` — endpoints and fields removed at the end of their
  deprecation window. Major-version releases only.
* `Fixed` — bug fixes that change observable but spec-conformant
  behaviour.
* `BREAKING SECURITY` — exceptional security-driven breaking changes
  shipped without a major version bump. Always paired with a
  CVE/security advisory.

## Client recommendations

* Pin to a specific minor version of Strata in production
  (`strata-server >=1.6,<1.7`) and bump after testing against the
  release notes.
* Treat unknown response fields as tolerated. Do not fail a request
  because the server returned a field your client does not know about.
* Treat unknown enum variants as a documented failure mode (e.g. show
  the raw string). Do not crash.
* Honour `Deprecation` and `Sunset` headers in tooling. Surface them
  in build pipelines so deprecations are noticed early.

## Out of scope

* The DMZ link protocol (`crates/strata-dmz`) has its own version field
  in the PSK handshake; see [docs/dmz-implementation-plan.md](dmz-implementation-plan.md).
* WebSocket message framing inside `/api/v1/sessions/{id}/ws` follows
  the Apache Guacamole protocol, whose stability is governed upstream.
* The audit log JSON schema is internal; consumers should treat fields
  as additive but expect occasional renames between major versions.
