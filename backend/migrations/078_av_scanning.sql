-- 078: Antivirus scan verdicts on outbound Quick Share submissions.
--
-- Records the verdict from the configured AV scanner backend
-- (`STRATA_AV_BACKEND=clamav|command|off`) at the moment the file
-- entered the staging directory. Persisted alongside the row so the
-- approver UI and downstream audit can show *who* scanned it, *when*,
-- and *what* the engine said — even after the blob has been purged.
--
-- All columns are nullable: rows submitted before AV scanning was
-- added (and rows ingested with `STRATA_AV_BACKEND=off`) report
-- `av_scan_status = NULL`, which the UI surfaces as "not scanned".
-- The status vocabulary is the same shape as the Rust
-- `services::av::Verdict` enum:
--   clean    — file passed the scan
--   infected — engine matched a signature (av_signature populated)
--   skipped  — engine deliberately did not scan (oversize, type filter)
--   error    — engine returned a non-deterministic error; whether the
--              upload was accepted is governed by `STRATA_AV_FAIL_MODE`
--              (`block` rejects, `allow` lets it through with this row)
ALTER TABLE outbound_shares
    ADD COLUMN IF NOT EXISTS av_scan_status      TEXT,
    ADD COLUMN IF NOT EXISTS av_signature        TEXT,
    ADD COLUMN IF NOT EXISTS av_scanned_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS av_scanner_backend  TEXT;

-- Cheap filtered index for the approver-queue "show me infected rows"
-- and "show me scan errors" filters. Most rows are `clean` or NULL so
-- the partial predicate keeps the index small.
CREATE INDEX IF NOT EXISTS idx_outbound_shares_av_attention
    ON outbound_shares(av_scan_status)
    WHERE av_scan_status IN ('infected', 'error');
