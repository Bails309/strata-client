# Runbook — SMTP / Notification troubleshooting

## Purpose

Diagnose and remediate cases where managed-account checkout notification emails are not arriving at recipients, or where the retry worker appears stalled.

## When to use

- Approvers report they did not receive a "checkout pending approval" email.
- Requesters report they did not receive an approved/rejected email.
- The **Admin → Notifications → Recent Deliveries** view shows growing `failed` counts.
- An alert fires on `notifications.abandoned` audit events (>0 per hour is unusual).
- After an SMTP relay credential rotation, no further messages send.

## Prerequisites

- Admin login with `can_manage_system`.
- SSH access to the host running the backend container (for log inspection).
- Optional: read access to the production database for direct `email_deliveries` queries.

## Safety checks

Before changing anything:

1. Confirm Vault is **unsealed** — `Admin → Vault` should show *Operational*. Saving SMTP credentials with Vault sealed will fail with a `400` and the request is safe to retry.
2. Note the current SMTP settings so you can revert: `GET /api/admin/notifications/smtp` (the password is never returned but `password_set` indicates whether one is stored).
3. Note the current count of `failed` rows: `GET /api/admin/notifications/deliveries?status=failed&limit=200`.

## Procedure

### Step 1 — Classify the symptom

Open **Admin → Notifications → Recent Deliveries** and look at the most recent rows.

| What you see | Jump to |
|---|---|
| No rows at all for recent checkouts | Step 2 (dispatcher not firing) |
| Rows with `status = 'suppressed'` | Step 3 (opt-out / misconfiguration) |
| Rows with `status = 'failed'`, `attempts < 3` | Step 4 (transient SMTP failure) |
| Rows with `status = 'failed'`, `attempts = 3` | Step 5 (abandoned — permanent failure) |
| Rows with `status = 'sent'` but recipient says nothing arrived | Step 6 (downstream filtering) |

### Step 2 — No rows at all

The dispatcher is not being invoked. Most common cause: `smtp_from_address` is empty or `smtp_enabled = false`, which causes the dispatcher to short-circuit before writing any rows.

```bash
# On the host, search the backend container logs for the misconfiguration audit event:
docker compose logs backend --since 1h | grep -i notifications.misconfigured
```

If you see entries:

1. **Admin → Notifications → SMTP**
2. Confirm **Enabled** is on, the **From Address** is non-empty and matches a sender your relay accepts (SPF/DMARC aligned).
3. Click **Save** and trigger a fresh checkout to confirm dispatch resumes.

If you see no `notifications.misconfigured` entries, check that the four call sites in `routes/user.rs` are reachable — the dispatcher only fires on `request_checkout` (Pending/SelfApproved) and `decide_checkout` (Approved/Rejected). A checkout that auto-completes through some other path will not produce notifications.

### Step 3 — Suppressed rows

`status = 'suppressed'` means the recipient has `users.notifications_opt_out = true`. This is intentional and audit-logged as `notifications.skipped_opt_out`. To re-enable notifications for a specific user:

```sql
UPDATE users SET notifications_opt_out = false WHERE email = 'user@contoso.com';
```

The change takes effect on the next dispatch — no restart required.

> [!NOTE]
> The self-approved audit notice intentionally bypasses opt-outs. If a user is suppressed for self-approval messages, that is a bug — file an issue.

### Step 4 — Transient SMTP failures (`attempts < 3`)

The retry worker (`services::email::worker`) re-attempts these on a 30-second tick with exponential backoff. To see what's happening:

```bash
# Watch the worker's tick output:
docker compose logs backend --since 5m -f | grep email_retry_worker
```

Inspect the `last_error` column of the failed rows in **Recent Deliveries**. Common transient errors:

| Error fragment | Likely cause | Fix |
|---|---|---|
| `connection refused` | Relay is down or unreachable from the backend container | Check relay status; verify the backend container can reach the relay (`docker compose exec backend nc -zv smtp.contoso.com 587`) |
| `timeout` | Network path slow or relay overloaded | Wait one tick; if persistent, raise the issue with the relay operator |
| `4.7.1 throttled` | Rate-limited by relay | Reduce checkout volume or contact relay operator |
| `tls handshake failed` | TLS/cert mismatch | Verify `tls_mode` matches the relay (port 587 → STARTTLS, port 465 → Implicit) |

Rows with `attempts >= 3` are abandoned — see Step 5.

### Step 5 — Abandoned rows (`attempts = 3` or permanent 5xx)

The retry worker has given up and emitted a `notifications.abandoned` audit event. To find out why:

```bash
docker compose logs backend --since 24h | grep -E 'notifications.abandoned|smtp.*5[0-9]{2}'
```

Common permanent failures:

| Error fragment | Cause | Fix |
|---|---|---|
| `550 sender rejected` | `From Address` not authorised on the relay | Use a verified sender; update SPF if necessary |
| `550 5.7.1 SPF/DMARC fail` | DNS records misaligned | Update SPF/DMARC for the From-domain |
| `554 relay denied` | Username/password rejected or relay disallows the recipient domain | Verify credentials; check relay allowlist |

To re-attempt an abandoned row after fixing the underlying issue:

```sql
-- ⚠ DESTRUCTIVE (re-queues the row for the worker to pick up):
UPDATE email_deliveries
   SET status = 'failed', attempts = 0, last_error = NULL
 WHERE id = '<delivery-id>';
```

The next worker tick will retry it. Use sparingly — large bulk re-queues can re-burn the same 5xx rejection.

### Step 6 — `sent` but recipient says nothing arrived

The relay accepted the message; downstream filtering or routing is the problem.

1. Check the recipient's spam/junk folder.
2. If the recipient is on Microsoft 365 / Google Workspace, check their tenant's quarantine.
3. Verify the From-domain has a valid DKIM signature (relays often relax SPF but reject on DKIM failure).
4. Some corporate gateways block messages with inline images by reputation. The Strata logo is delivered as `cid:strata-logo` (RFC 2392 reference inside `multipart/related`), which is the standard approach — but if your gateway flags it, consider switching to a hosted logo URL (template change required).

## Verification

After any fix:

1. Click **Send Test Email** in **Admin → Notifications** with a recipient address you control.
2. Confirm the message arrives within 60 seconds.
3. Check **Recent Deliveries** for a fresh `status = 'sent'` row.
4. Trigger a real checkout (or use a staging environment) to confirm the dispatcher hooks fire end-to-end.

## Rollback

If the SMTP credential change broke worse than what came before:

1. **Admin → Notifications → SMTP**
2. Restore the previous `host`, `port`, `username`, and `from_address` values from your safety-check notes.
3. Set the password to the previous known-good value (this re-seals it in Vault).
4. Click **Save** and verify with a test send.

If the retry worker has piled up many failed rows from the bad config period, you can mark them all suppressed to clear the queue without re-attempting:

```sql
-- ⚠ DESTRUCTIVE (do not run unless you accept losing those notifications):
UPDATE email_deliveries
   SET status = 'suppressed', last_error = 'admin-cleared after bad config'
 WHERE status = 'failed' AND created_at > now() - interval '6 hours';
```

## Related

- [ADR-0008 — Notification pipeline](../adr/ADR-0008-notification-pipeline.md)
- [docs/architecture.md § Transactional-Email Pipeline](../architecture.md#transactional-email-pipeline)
- [docs/security.md § Notification Pipeline](../security.md#notification-pipeline-transactional-email)
- [docs/deployment.md § 9. Notification Email (SMTP)](../deployment.md#9-notification-email-smtp)
- [vault-operations.md](vault-operations.md) — for unsealing Vault if SMTP saves are failing with sealed-Vault errors

## Review

- Last reviewed: 2026-04-25
- Next review due: 2026-07-25
