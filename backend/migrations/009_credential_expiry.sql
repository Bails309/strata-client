-- ── Credential Profile Expiry ─────────────────────────────────────────
-- Adds an expiry timestamp to credential profiles so that stored
-- passwords automatically expire after a configurable TTL (max 12 hrs).
-- When expires_at < now(), the profile is treated as expired and the
-- user must update their password before it will be used again.

ALTER TABLE credential_profiles
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Default all existing profiles to expire 12 hours from now so users
-- are not immediately locked out after the migration.
UPDATE credential_profiles SET expires_at = now() + INTERVAL '12 hours' WHERE expires_at IS NULL;

-- Make the column NOT NULL going forward
ALTER TABLE credential_profiles ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE credential_profiles ALTER COLUMN expires_at SET DEFAULT now() + INTERVAL '12 hours';

-- Add a system setting for the credential TTL (in hours). Max allowed = 12.
INSERT INTO system_settings (key, value, updated_at)
VALUES ('credential_ttl_hours', '12', now())
ON CONFLICT (key) DO NOTHING;
