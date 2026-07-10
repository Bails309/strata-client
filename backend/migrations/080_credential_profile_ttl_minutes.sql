-- ── Minute-precision credential TTLs ─────────────────────────────────
-- Adds a `ttl_minutes` sub-hour component to `credential_profiles` so
-- operators can pin an expiry like "1 hour 30 minutes" or "45 minutes"
-- via the profile editor. Effective lifetime = ttl_hours * 60 + ttl_minutes
-- minutes.
--
-- Existing rows are unchanged (ttl_minutes defaults to 0), so a stored
-- `ttl_hours = 12` continues to mean exactly 12 hours.
--
-- The CHECK constraint is rewritten in minutes:
--   • non-extended:   15 ≤ effective ≤ 720   (12 h)
--   • extended:       15 ≤ effective ≤ 129600 (90 d)

ALTER TABLE credential_profiles
    ADD COLUMN IF NOT EXISTS ttl_minutes INTEGER NOT NULL DEFAULT 0;

-- Replace the hours-only CHECK with one that spans both components.
ALTER TABLE credential_profiles DROP CONSTRAINT IF EXISTS chk_ttl_hours;
ALTER TABLE credential_profiles
    ADD CONSTRAINT chk_ttl_hours CHECK (
        ttl_minutes >= 0
        AND ttl_minutes < 60
        AND (ttl_hours * 60 + ttl_minutes) >= 15
        AND (
            (extended_expiry = FALSE AND (ttl_hours * 60 + ttl_minutes) <= 720)
            OR (extended_expiry = TRUE AND (ttl_hours * 60 + ttl_minutes) <= 129600)
        )
    );
