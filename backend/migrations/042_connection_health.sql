-- ════════════════════════════════════════════════════════════════════════
-- 042: Connection Health Check
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE connections ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('online', 'offline', 'unknown'));
ALTER TABLE connections ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ;
