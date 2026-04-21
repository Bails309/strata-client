# Runbook — Security Incident Response

**Purpose:** Contain, investigate, and remediate a confirmed or suspected
security incident affecting the Strata deployment.

## When to use

- Credential exposure alert (leaked secret in logs, accidental commit).
- Spike in failed logins or 401/403 against `/api/auth/refresh`.
- Spike in `pm.checkout.emergency` audit events without corresponding
  change tickets.
- IDS / EDR alert naming a Strata host or container.
- User report of an unexpected session or visible recording.
- Any "was this us?" question raised by security / audit.

## Prerequisites

- Admin role in Strata.
- SSH / console access to the Strata host.
- Access to the Vault unseal quorum (for key-rotation steps).
- A ticket in the incident tracker — open one now if you don't have one.

## Severity classes

| Sev | Examples | First response |
|---|---|---|
| **SEV-1** | Active credential theft, unauthenticated RCE, live data exfil | Page on-call, start war-room, follow §Immediate containment |
| **SEV-2** | Stolen refresh token detected via replay alert, one compromised user account | Disable account, rotate that user's tokens, investigate |
| **SEV-3** | Suspicious but inconclusive signal | Open ticket, gather evidence, escalate if confirmed |

## Immediate containment (SEV-1)

> ⚠ Do these first; investigate later.

1. **Revoke all sessions.** Bump the global signing key so every
   access and refresh token becomes invalid:

   ```bash
   docker compose exec vault \
     vault write -f transit/keys/guac-master-key/rotate
   # then force every backend to re-read keys
   docker compose restart backend
   ```

   Every user is logged out; a fresh login is required.
2. **Disable local auth** if the attacker is hitting `/api/auth/login`
   directly: admin UI → Security tab → uncheck **Local Authentication**,
   Save. SSO continues to work if configured.
3. **Take the public endpoint offline** if the attack is ongoing and
   you cannot contain at layer 7:

   ```bash
   docker compose stop nginx
   ```

   Internal admin tooling keeps working via the Docker network.
4. **Freeze state for forensics** before restarting anything:

   ```bash
   docker compose exec postgres-local \
     pg_dump -U strata strata | gzip > /tmp/incident-$(date +%s).sql.gz
   docker compose logs --no-color > /tmp/incident-$(date +%s).log
   tar czf /tmp/incident-evidence.tar.gz /tmp/incident-*.sql.gz /tmp/incident-*.log
   ```

   Copy the evidence bundle off-host before doing anything destructive.

## Investigation

1. **Audit log review.** Every privileged action writes an audit row.
   Pull the window of interest:

   ```sql
   SELECT created_at, user_id, event, payload
     FROM audit_logs
    WHERE created_at > now() - interval '24 hours'
    ORDER BY created_at DESC;
   ```

2. **Session review.** Find unexpected sessions:

   ```sql
   SELECT s.id, s.user_id, s.ip_address, s.user_agent, s.created_at, s.expires_at
     FROM active_sessions s
    WHERE s.created_at > 'YYYY-MM-DD HH:MM'
    ORDER BY s.created_at;
   ```

3. **Emergency-bypass review.** See ADR-0007:

   ```sql
   SELECT c.id, c.user_id, c.connection_id, c.created_at, c.justification
     FROM checkouts c
    WHERE c.emergency_bypass = true
      AND c.created_at > now() - interval '7 days';
   ```

4. **Recording review.** If the incident involved session hijack:

   ```sql
   SELECT id, user_id, connection_id, started_at, storage_path
     FROM recordings
    WHERE started_at > 'YYYY-MM-DD HH:MM'
    ORDER BY started_at;
   ```

5. **Token revocation list.** Replay attempts show up here:

   ```sql
   SELECT * FROM revoked_tokens
    WHERE revoked_at > now() - interval '24 hours';
   ```

## Remediation

Select the subset of steps that apply to the incident class.

### Compromised user account

1. Soft-delete the user in the admin UI.
2. Rotate any credentials that user ever checked out:

   ```sql
   SELECT DISTINCT c.connection_id, c.created_at
     FROM checkouts c
    WHERE c.user_id = '<uuid>';
   ```

   Each listed connection's target password must be rotated on the
   managed account itself (PM auto-rotate is the fast path — set a
   1-hour schedule, then restore the normal schedule).
3. Revoke all refresh tokens for that user:

   ```sql
   INSERT INTO revoked_tokens (jti, expires_at)
   SELECT jti, expires_at FROM issued_tokens WHERE user_id = '<uuid>';
   ```

### Leaked signing key or envelope key

1. Rotate the Vault Transit key (see `vault-operations.md § Rotate`).
2. Run the rewrap job to upgrade existing envelope ciphertexts.
3. Rotate the JWT signing key — this logs everyone out.
4. File a disclosure note per your org's policy.

### Unauthorised config change

1. Use the audit log to identify `settings.*` changes.
2. Revert via the admin UI or directly:

   ```sql
   -- preview first
   SELECT * FROM settings_audit WHERE key = '<key>' ORDER BY created_at DESC LIMIT 5;
   UPDATE settings SET value = '<previous-value>' WHERE key = '<key>';
   ```

## Verification

- `docker compose ps` shows every service healthy.
- A fresh login succeeds.
- `pm.checkout.emergency` metric has returned to baseline.
- No new entries in `revoked_tokens` other than the ones you
  intentionally inserted.

## Post-incident

1. Write a blameless post-mortem within 5 business days.
2. Cross-reference audit-log gaps against findings — any gap is
   itself a finding.
3. Update detections / alerts so the same class of incident
   triggers earlier next time.
4. File tracker items for any latent weaknesses surfaced.

## Related

- [../adr/ADR-0005-jwt-refresh-token-sessions.md](../adr/ADR-0005-jwt-refresh-token-sessions.md)
- [../adr/ADR-0007-emergency-bypass-checkouts.md](../adr/ADR-0007-emergency-bypass-checkouts.md)
- [vault-operations.md](vault-operations.md)

---

_Last reviewed: 2026-04-21_
