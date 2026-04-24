-- Partial index to speed up the email worker's retry sweep.
--
-- The worker runs a query of the form:
--     SELECT … FROM email_deliveries
--      WHERE status = 'failed' AND attempts < 3
--        AND created_at + …backoff… <= now()
--      ORDER BY created_at
--      LIMIT 50;
--
-- Without a dedicated index, this becomes a seq-scan over the entire
-- delivery history once the table grows — even though the "retryable"
-- population is tiny (a handful of rows with status='failed' and
-- attempts<3). A partial index keyed on created_at keeps the scan cheap
-- and ordered, and stays small because successfully-sent rows are
-- excluded from the index entirely.

CREATE INDEX IF NOT EXISTS email_deliveries_retry_idx
    ON email_deliveries (created_at)
    WHERE status = 'failed' AND attempts < 3;
