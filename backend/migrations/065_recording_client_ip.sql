-- Migration 065: record the client IP (operator's public source IP) on each
-- session recording so the admin Sessions blade can render where each
-- historical recording was initiated from.
--
-- The live Sessions blade already has access to the same value via the
-- in-memory `session_registry::ActiveSession.client_ip` field; this column
-- is the on-disk persistence of that same value, captured at NVR-insert time
-- so it survives backend restarts and shows up on the Recordings tab.
--
-- The column is nullable for backwards compatibility: recordings created
-- before this migration will have `client_ip IS NULL`. The frontend renders
-- those as an italic "Unknown" placeholder.

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS client_ip TEXT;
