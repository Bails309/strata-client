-- 055_notifications.sql
--
-- Modern Managed-Account Notification Emails (roadmap item delivered in
-- v0.25.0).  Three linked changes:
--
-- 1. **Per-user opt-out** — adds `users.notifications_opt_out`.  Audit-log
--    category events (self-approval, emergency-bypass usage) intentionally
--    ignore this flag because they exist precisely for the audit record;
--    all other transactional emails honour it.  Every suppression is
--    logged as a `notifications.skipped_opt_out` audit event.
--
-- 2. **Delivery audit table** — `email_deliveries` records every attempted
--    send with its terminal status.  The rendered body is deliberately NOT
--    stored; only metadata (template key, recipient, subject, related
--    entity, status, attempts, error).  This keeps sensitive justification
--    text in a single place (the source checkout row) and limits PII
--    sprawl.
--
-- 3. **SMTP + branding defaults** — seeds the eight new `system_settings`
--    keys so the Notifications admin tab has something to render on first
--    boot.  `smtp_enabled` starts `false` and `smtp_from_address` starts
--    empty, which intentionally blocks the dispatcher until an admin has
--    supplied a verified From address (SPF/DMARC hygiene).  The SMTP
--    password key is managed separately via Vault's Transit engine using
--    the existing `seal_setting` / `unseal_setting` helpers (same pattern
--    as `recordings_azure_access_key`); no plaintext password is ever
--    written to `system_settings`.

BEGIN;

-- (1) Per-user opt-out
ALTER TABLE users
    ADD COLUMN notifications_opt_out BOOLEAN NOT NULL DEFAULT false;

-- (2) Delivery audit table
CREATE TABLE email_deliveries (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    template_key         TEXT         NOT NULL,
    recipient_user_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
    recipient_email      TEXT         NOT NULL,
    subject              TEXT         NOT NULL,
    related_entity_type  TEXT,
    related_entity_id    UUID,
    status               TEXT         NOT NULL
                         CHECK (status IN ('queued','sent','failed','bounced','suppressed')),
    attempts             INT          NOT NULL DEFAULT 0,
    last_error           TEXT,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sent_at              TIMESTAMPTZ
);

CREATE INDEX email_deliveries_status_created_idx
    ON email_deliveries (status, created_at);

CREATE INDEX email_deliveries_related_idx
    ON email_deliveries (related_entity_type, related_entity_id);

CREATE INDEX email_deliveries_recipient_user_idx
    ON email_deliveries (recipient_user_id)
    WHERE recipient_user_id IS NOT NULL;

-- (3) Seed SMTP + branding defaults.  ON CONFLICT DO NOTHING so a re-run
--     never clobbers values the admin has already set through the UI.
INSERT INTO system_settings (key, value) VALUES
    ('smtp_enabled',          'false'),
    ('smtp_host',             ''),
    ('smtp_port',             '587'),
    ('smtp_username',         ''),
    ('smtp_tls_mode',         'starttls'),   -- 'starttls' | 'implicit' | 'none'
    ('smtp_from_address',     ''),
    ('smtp_from_name',        'Strata Client'),
    ('branding_accent_color', '#2563eb')
ON CONFLICT (key) DO NOTHING;

COMMIT;
