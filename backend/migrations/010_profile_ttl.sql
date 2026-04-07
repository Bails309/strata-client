-- ── Per-Profile TTL ──────────────────────────────────────────────────
-- Let each user choose how long their credentials stay valid (1–12 hrs).
-- The column stores the user's chosen TTL; expires_at is computed from it.

ALTER TABLE credential_profiles
    ADD COLUMN IF NOT EXISTS ttl_hours INTEGER NOT NULL DEFAULT 12;

-- Constrain to 1–12 range
ALTER TABLE credential_profiles
    ADD CONSTRAINT chk_ttl_hours CHECK (ttl_hours >= 1 AND ttl_hours <= 12);
