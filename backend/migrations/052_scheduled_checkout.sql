-- ════════════════════════════════════════════════════════════════════════
-- 052: Scheduled checkout start time
-- ════════════════════════════════════════════════════════════════════════
--
-- Allows a user to request a password checkout that is not released until
-- a future point in time. When scheduled_start_at is set and is in the
-- future at request time, the row is held at status = 'Scheduled' and the
-- background worker will activate it once the clock passes the timestamp.
--
-- The status CHECK constraint is extended to include 'Scheduled'.

ALTER TABLE password_checkout_requests
    ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ;

-- Drop the old CHECK constraint and recreate with 'Scheduled' added
ALTER TABLE password_checkout_requests
    DROP CONSTRAINT IF EXISTS password_checkout_requests_status_check;

ALTER TABLE password_checkout_requests
    ADD CONSTRAINT password_checkout_requests_status_check
    CHECK (status IN ('Pending', 'Approved', 'Scheduled', 'Active', 'Expired', 'Denied', 'CheckedIn'));

CREATE INDEX IF NOT EXISTS idx_password_checkout_requests_scheduled_start_at
    ON password_checkout_requests (scheduled_start_at)
    WHERE status = 'Scheduled';
