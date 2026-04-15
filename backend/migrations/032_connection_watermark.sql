-- Per-connection watermark override: 'inherit' (use global setting), 'on', or 'off'
ALTER TABLE connections ADD COLUMN IF NOT EXISTS watermark TEXT NOT NULL DEFAULT 'inherit'
    CHECK (watermark IN ('inherit', 'on', 'off'));
