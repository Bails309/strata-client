-- 077: Capture an approver's reason on a checkout decision
--
-- Until now `password_checkout_requests.status = 'Denied'` carried no
-- explanation, so a requester reading the audit trail saw only "Grace
-- declined your request" with no further context. Outbound Quick-Share
-- already persists a `decision_reason` per row (see migration 073) and
-- the new in-session approval popup (frontend `PendingApprovalWatcher`)
-- requires a reason before letting an approver hit Deny.
--
-- This migration adds the matching column to the credential-checkout
-- queue so the same reason can be persisted, audit-logged, and surfaced
-- back to the requester in the rejection email. The column is nullable
-- (legacy denials predate this field) and has no default so legacy rows
-- remain visibly NULL rather than backfilled to an empty string.
--
-- No length constraint here — the handler enforces a server-side limit
-- (1024 chars trimmed) which matches the outbound share enforcement so
-- the two queues stay symmetric.

ALTER TABLE password_checkout_requests
    ADD COLUMN IF NOT EXISTS decision_reason TEXT;

COMMENT ON COLUMN password_checkout_requests.decision_reason IS
    'Free-form reason captured from the approver when they decide a checkout. ' ||
    'Required by the UI on Deny; optional on Approve. Maximum 1024 chars enforced ' ||
    'by the handler before INSERT. NULL for legacy rows that predate migration 077.';
