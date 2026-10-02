-- Periodic jobs that one backend replica at a time should run (PERF-09).
-- A replica claims a job's row for a pass; writes made by the pass check
-- that it still holds the claim.
CREATE TABLE IF NOT EXISTS worker_leases (
    name         TEXT PRIMARY KEY,
    holder       UUID NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    -- When a pass last completed, whichever replica ran it.
    completed_at TIMESTAMPTZ
);
