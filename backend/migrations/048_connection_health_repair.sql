-- ════════════════════════════════════════════════════════════════════════
-- 048: Repair connection health columns (idempotent)
-- Ensures health_status and health_checked_at exist even if 042 was
-- recorded as applied but the DDL did not take effect.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE connections ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE connections ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'connections_health_status_check'
          AND conrelid = 'connections'::regclass
    ) THEN
        ALTER TABLE connections ADD CONSTRAINT connections_health_status_check
            CHECK (health_status IN ('online', 'offline', 'unknown'));
    END IF;
END $$;
