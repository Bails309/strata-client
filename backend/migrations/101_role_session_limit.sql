-- Concurrent sessions a member of the role may hold (PERF-04).
-- NULL means no per-role limit.
ALTER TABLE roles
    ADD COLUMN IF NOT EXISTS max_concurrent_sessions INTEGER
        CHECK (max_concurrent_sessions IS NULL OR max_concurrent_sessions > 0);
