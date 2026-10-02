-- Login and password-change attempt limits, shared by every backend
-- replica (SEC-19). One row per admitted attempt; a bucket is a limit's
-- name plus the key it counts (account, address, ...).
CREATE TABLE IF NOT EXISTS auth_attempts (
    id           BIGSERIAL PRIMARY KEY,
    bucket       TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS auth_attempts_bucket_time ON auth_attempts (bucket, attempted_at);
CREATE INDEX IF NOT EXISTS auth_attempts_time ON auth_attempts (attempted_at);

-- Admit one attempt in p_bucket if fewer than p_max were admitted in the
-- last p_window_secs. Returns the attempt's id, or NULL and the whole
-- seconds until the oldest attempt leaves the window. Serialised per
-- bucket, so concurrent callers on any replica cannot overshoot.
CREATE OR REPLACE FUNCTION auth_attempt_reserve(
    p_bucket TEXT,
    p_max INT,
    p_window_secs INT,
    OUT attempt_id BIGINT,
    OUT retry_after_secs INT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_now    TIMESTAMPTZ := clock_timestamp();
    v_window INTERVAL := make_interval(secs => p_window_secs);
    v_count  INT;
    v_oldest TIMESTAMPTZ;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('auth_attempt'), hashtext(p_bucket));

    DELETE FROM auth_attempts WHERE bucket = p_bucket AND attempted_at <= v_now - v_window;
    -- Buckets nobody touches again (one-off addresses) are cleared a few at a time.
    DELETE FROM auth_attempts WHERE id IN (
        SELECT id FROM auth_attempts
        WHERE attempted_at < v_now - INTERVAL '1 hour'
        LIMIT 100 FOR UPDATE SKIP LOCKED
    );

    SELECT count(*), min(attempted_at) INTO v_count, v_oldest
    FROM auth_attempts WHERE bucket = p_bucket;

    IF v_count < p_max THEN
        INSERT INTO auth_attempts (bucket, attempted_at) VALUES (p_bucket, v_now)
        RETURNING id INTO attempt_id;
        retry_after_secs := 0;
    ELSE
        attempt_id := NULL;
        retry_after_secs := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_oldest + v_window - v_now)))::INT);
    END IF;
END
$$;
