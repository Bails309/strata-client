-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  Strata Client – Share Mode (view / control)                     ║
-- ╚═══════════════════════════════════════════════════════════════════╝

-- Replace the boolean read_only with a text mode field supporting
-- 'view' (read-only) and 'control' (full input forwarding).
ALTER TABLE connection_shares ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'view';

-- Backfill existing shares: read_only=true → 'view', read_only=false → 'control'
UPDATE connection_shares SET mode = CASE WHEN read_only THEN 'view' ELSE 'control' END;
