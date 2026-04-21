# Pull Request

## Summary

<!-- One or two sentences describing the change. Link related ADRs / tracker items. -->

## Change type

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor / cleanup
- [ ] Security fix
- [ ] Documentation only
- [ ] Dependency update
- [ ] Migration / schema change

## Compliance checklist

Tick every item that applies, or explain in the PR body why it does not.

### Coding Standards

- [ ] Ran `cargo fmt` / `cargo clippy --all-targets -- -D warnings` locally (backend)
- [ ] Ran `npx tsc --noEmit` and `npm test` locally (frontend)
- [ ] New/changed public functions have Rustdoc / TSDoc comments describing inputs, outputs, and failure modes
- [ ] All SQL is parameterised via `sqlx::query!` / `query_as!` — no string-built queries (§3.1)
- [ ] New outbound HTTP / LDAP / Vault calls have explicit timeouts + retry/backoff (§3.3)
- [ ] No secrets / credentials / tokens in logs or error messages (§11.3)

### Database migrations (§15.4 / W2-3)

If this PR adds a file in `backend/migrations/`:

- [ ] Migration is **idempotent** (safe to re-apply); destructive DDL uses `DROP ... IF EXISTS`
- [ ] Destructive changes (`DROP COLUMN`, `DROP TABLE`, type narrowing) are **split across two releases** — N marks deprecated + stops writing; N+1 drops — and the PR body names both release windows
- [ ] Migration number is sequential and does not collide with an open PR's number
- [ ] Re-running the migration locally (`sqlx migrate run` twice) is a no-op on the second run
- [ ] Accompanying code changes tolerate both the pre-migration and post-migration schema during the rollout window

### Security

- [ ] No new endpoint is unauthenticated unless explicitly justified in the PR body
- [ ] Admin-only endpoints are wrapped by `require_admin` and the appropriate `check_*_permission` helper
- [ ] User-supplied input is validated at the route boundary (length, charset, enum)
- [ ] Error messages returned to clients do not leak internals (stack traces, raw SQL, DNs, file paths)

### Tests

- [ ] Added/updated unit tests for new logic
- [ ] Added/updated e2e or integration coverage if the change crosses service boundaries
- [ ] Verified the change against the CheckedIn / expired / scheduled checkout edge cases (if relevant)

## Related

<!--
Link ADRs, runbooks, compliance-tracker items, or issues:
  - docs/compliance-tracker.md — W2-3
  - docs/adrs/0001-architecture-baseline.md
-->
