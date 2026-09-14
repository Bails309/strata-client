-- Which session engine served a recording.
--
-- While the native Rust engine rolls out alongside guacd, a recording on
-- its own does not say which of the two produced it. That matters twice
-- over: an operator investigating a session cannot tell which code path
-- to look at, and the bandwidth columns already on this table cannot be
-- compared between the engines without it.
--
-- Nullable with no default: rows written before this migration were all
-- served by guacd, but backfilling them would assert something the data
-- does not record, and NULL says "unknown" honestly.
ALTER TABLE recordings
    ADD COLUMN IF NOT EXISTS engine TEXT;

COMMENT ON COLUMN recordings.engine IS
    'Session engine that served this recording: guacd or native. NULL for rows predating the native engine.';
