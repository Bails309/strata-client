-- ── Extended-expiry credential profiles ──────────────────────────────
-- Lets a user opt a single credential profile out of the standard
-- 1–12 hour cap so service / break-glass accounts can hold a longer
-- working credential (up to 90 days = 2160 hours). Per-profile boolean
-- so the default profile remains short-lived.

ALTER TABLE credential_profiles
    ADD COLUMN IF NOT EXISTS extended_expiry BOOLEAN NOT NULL DEFAULT FALSE;

-- Replace the hard 1–12 check with one that depends on extended_expiry.
ALTER TABLE credential_profiles DROP CONSTRAINT IF EXISTS chk_ttl_hours;
ALTER TABLE credential_profiles
    ADD CONSTRAINT chk_ttl_hours CHECK (
        ttl_hours >= 1
        AND (
            (extended_expiry = FALSE AND ttl_hours <= 12)
            OR (extended_expiry = TRUE AND ttl_hours <= 2160)
        )
    );
