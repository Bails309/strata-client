# Operational Runbooks

This directory contains step-by-step runbooks for operating Strata Client in
production. Runbooks are **procedural** — they tell an on-call engineer
exactly what to do, in order, to achieve a specific outcome. They are
**not** design documents (those live in [../adrs/](../adrs/)) and they are
**not** architectural overviews (those live in
[../architecture.md](../architecture.md)).

## When to write a runbook

Write one the first time you answer _"how do we do X in prod"_ where X is
repeatable, time-sensitive, or risky. Typical triggers:

- A customer-visible incident has a known remediation sequence.
- A scheduled maintenance task (cert rotation, key rotation, failover drill).
- A recovery procedure (restore from backup, unseal Vault, re-run a
  migration).

## Format

Every runbook in this directory should contain, at minimum:

1. **Purpose** — one sentence.
2. **When to use** — what signals / alerts / scheduled events trigger this
   runbook.
3. **Prerequisites** — access rights, tooling, environment.
4. **Safety checks** — "before you touch anything" validation.
5. **Procedure** — numbered, copy-pasteable steps. Destructive steps must be
   explicitly flagged `⚠ DESTRUCTIVE`.
6. **Verification** — how to confirm the procedure worked.
7. **Rollback** — what to do if a step fails.
8. **Related** — ADRs, other runbooks, dashboards.

## Conventions

- Filename: `kebab-case.md` (e.g. `disaster-recovery.md`).
- Keep each runbook self-contained; duplicate small snippets between
  runbooks rather than cross-linking mid-procedure.
- Commands in fenced code blocks, one shell per block; annotate dangerous
  operations (`⚠`).
- Include **expected output** for verification steps so on-call doesn't have
  to guess.
- Review runbooks at least quarterly; record the review date at the bottom.

## Index

The runbooks listed below cover §26/§28 of the Coding Standards.

| Runbook                  | Scope                                                       | Status |
| ------------------------ | ----------------------------------------------------------- | ------ |
| disaster-recovery.md     | Backup/restore, RTO/RPO                                     | Active |
| security-incident.md     | Security incident response; refresh-token reuse; audit integrity failure | Active |
| certificate-rotation.md  | ACME + internal CA rotation; bundled Vault TLS certificate  | Active |
| vault-operations.md      | Vault unseal, rekey, rotate keys                            | Active |
| database-operations.md   | Postgres failover, migration rollback, edited-migration refusal | Active |
| dmz-incident.md          | DMZ split-topology incident response                        | Active |
| dmz-production-certs.md  | Production DMZ mTLS cert generation & setup                 | Active |
| smtp-troubleshooting.md  | Notification email delivery failures, retry-worker stalls   | Active |
| av-operations.md         | AV scanner outage, signature updates, false-positive triage | Active |
| clipboard-diagnostics.md | RDP clipboard failure triage, recovery & evidence capture   | Active |
| session-disconnects.md   | Unexpected session ends: on-screen message → cause → log; the **Reconnecting…** spinner and reconnect loops (v2.3.8) | Active |
| keyboard-input.md        | Wrong characters, console prompt ignores typing, keypad, stuck keys | Active |
| login-rate-limiting.md   | `429` on sign-in, password change or session capacity       | Active |
| session-capacity.md      | New sessions refused at capacity or a per-user limit; raising the budget | Active |
| recording-storage.md     | Recordings stuck on local storage instead of Azure Blob; recordings volume filling (v2.3.10) | Active |
