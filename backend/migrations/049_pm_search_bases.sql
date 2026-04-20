-- ════════════════════════════════════════════════════════════════════════
-- 049: Password Management Separate Search Bases
-- ════════════════════════════════════════════════════════════════════════

-- Add a separate column for Password Management discovery OUs.
-- If empty, the system falls back to the main 'search_bases' field.
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_search_bases TEXT[] NOT NULL DEFAULT '{}';
