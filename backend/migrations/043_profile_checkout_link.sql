-- ════════════════════════════════════════════════════════════════════════
-- 043: Link credential profiles to password checkouts
-- ════════════════════════════════════════════════════════════════════════

-- Allow profiles to track which checkout they're sourced from.
ALTER TABLE credential_profiles
    ADD COLUMN IF NOT EXISTS checkout_id UUID REFERENCES password_checkout_requests(id) ON DELETE SET NULL;

-- Allow encrypted_username to be NULL for managed credential profiles
-- (where username+password are stored together in encrypted_password as JSON).
ALTER TABLE credential_profiles ALTER COLUMN encrypted_username DROP NOT NULL;
ALTER TABLE credential_profiles ALTER COLUMN encrypted_username SET DEFAULT NULL;
