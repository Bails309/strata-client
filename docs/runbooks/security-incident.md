# Runbook — Security Incident Response

**Purpose:** Contain, investigate, and remediate a confirmed or suspected
security incident affecting the Strata deployment.

## When to use

- Credential exposure alert (leaked secret in logs, accidental commit).
- Spike in failed logins or 401/403 against `/api/auth/refresh`.
- An `auth.refresh_token_reused` audit event (v2.3.0): a spent refresh
  token was presented again, which usually means a copied cookie.
- An `audit.integrity_failed` audit event or an error on the
  `strata::audit_integrity` log target (v2.3.0): see
  [Audit integrity failure](#audit-integrity-failure-v230).
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

1. **Revoke all sessions.** Since v2.3.0 every access and refresh token
   is checked against `users.sessions_valid_after` on each request, so
   setting it signs every account out at once, and the backend closes
   their open remote sessions within 30 seconds:

   ```bash
   docker compose exec postgres-local psql -U strata -d strata \
     -c "UPDATE users SET sessions_valid_after = now();"
   ```

   Every user, including you, must sign in again. If `JWT_SECRET` itself
   may have leaked, also replace it and restart the backend, since anyone
   holding it can mint new tokens. (Rotating the Vault Transit key does
   **not** sign anyone out; it protects stored credentials, not tokens.)
2. **Disable local auth** if the attacker is hitting `/api/auth/login`
   directly: admin UI → Security tab → uncheck **Local Authentication**,
   Save. SSO continues to work if configured. Sign-in attempts are
   already limited in PostgreSQL across every replica (see
   [login-rate-limiting.md](login-rate-limiting.md)).
3. **Take the public endpoint offline** if the attack is ongoing and
   you cannot contain at layer 7:

   ```bash
   docker compose stop frontend
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
   SELECT created_at, user_id, action_type, details
     FROM audit_logs
    WHERE created_at > now() - interval '24 hours'
    ORDER BY created_at DESC;
   ```

   The audit log is append-only since v2.3.0: its triggers refuse
   `UPDATE`, `DELETE` and `TRUNCATE`, so what you read was not edited
   through the application. Check the verifier before relying on it:
   `GET /api/admin/audit-status` should show `"problems": []`.

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
    WHERE created_at > now() - interval '24 hours';
   ```

6. **Refresh-token reuse (v2.3.0).** Each sign-in starts a family of
   refresh tokens; presenting a spent one revokes the family and writes
   `auth.refresh_token_reused`:

   ```sql
   SELECT created_at, user_id, details->>'family_id' AS family_id
     FROM audit_logs
    WHERE action_type = 'auth.refresh_token_reused'
      AND created_at > now() - interval '7 days';

   SELECT jti, issued_at, consumed_at, revoked_at
     FROM refresh_tokens
    WHERE family_id = '<family_id>'
    ORDER BY issued_at;
   ```

   One event after a user restored a browser profile or ran two copies of
   one profile is usually benign. Repeated events for one user, or events
   whose sign-in address differs from the user's usual one, point to a
   stolen cookie: treat as a compromised account.

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
3. Sign the user out everywhere. Since v2.3.0 a password reset or
   deletion does this by itself (`users.sessions_valid_after`); to do it
   without either:

   ```sql
   UPDATE users SET sessions_valid_after = now() WHERE id = '<uuid>';
   ```

   Every access and refresh token issued to that user before now is
   refused on its next use, and their open remote sessions close within
   30 seconds.

### Audit integrity failure (v2.3.0)

The verifier checks new audit rows every 10 minutes and the whole chain
daily, and checks the newest anchor in `STRATA_AUDIT_ANCHOR_PATH`. A
problem is logged on `strata::audit_integrity` and recorded once as
`audit.integrity_failed` with a `problems` list.

1. Read the problems:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" https://<host>/api/admin/audit-status | jq .verifier
   ```

2. Classify each one:

   | Problem text | Likely cause |
   | ------------ | ------------ |
   | `row N does not follow the row before it` | A row was removed, reordered or inserted outside `audit_append` |
   | `row N does not match its digest` | A row's contents were changed |
   | `row N is in the legacy format after the v2 switch` | A pre-2.3.0 backend replica is still writing, or a row was inserted directly |
   | `anchor: …` / `fails its Vault signature` | The checkpoints table or the anchor file was changed, or the database was restored from a backup older than the newest anchor |
   | `the audit anchor file cannot be read` | Volume not mounted or permissions changed |

3. Rule out the benign causes first: a replica still on an older
   version (upgrade it), or a database restore (record it; keep the old
   anchor file with the incident record).
4. Otherwise treat it as SEV-1: someone with database write access has
   changed history. Freeze state (§ Immediate containment step 4),
   preserve the anchor file off-host, and compare the anchored row ids
   and digests with the database to find what changed.

The table owner can still drop the triggers; the runtime role the
backend serves requests with cannot (SEC-25). A finding therefore points
at whoever holds the owner credentials or the host.

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
- [login-rate-limiting.md](login-rate-limiting.md)
- [../security.md § Audit Trail](../security.md#audit-trail)

---

_Last reviewed: 2026-10-02 (v2.3.0)_
