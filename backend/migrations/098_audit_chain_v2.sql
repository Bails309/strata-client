-- Audit chain v2 (SEC-17), one-call append (PERF-12) and search indexes
-- (PERF-11). Index builds on a large audit table can outlast the pool's
-- statement timeout.
SET LOCAL statement_timeout = 0;

-- A SET NULL foreign key rewrites hashed rows when a user is deleted, and
-- attribution should outlive the account anyway.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey;

-- Version 1 hashes only previous_hash, action_type and details, so existing
-- rows keep 1. The default stays 1 so a row inserted around audit_append
-- reads as legacy, which the verifier refuses after the first v2 row.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS hash_version SMALLINT NOT NULL DEFAULT 1;

-- Every field length-prefixed, so no two events encode the same.
CREATE OR REPLACE FUNCTION audit_field(x TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT octet_length(x) || ':' || x
$$;

CREATE OR REPLACE FUNCTION audit_canonical_v2(
    p_id BIGINT,
    p_created_at TIMESTAMPTZ,
    p_user_id UUID,
    p_action TEXT,
    p_details JSONB,
    p_previous TEXT
) RETURNS TEXT
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT 'strata-audit-v2'
        || audit_field(p_id::text)
        || audit_field(to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
        || audit_field(coalesce(p_user_id::text, ''))
        || audit_field(p_action)
        || audit_field(p_details::text)
        || audit_field(p_previous)
$$;

CREATE OR REPLACE FUNCTION audit_hash_v2(
    p_id BIGINT,
    p_created_at TIMESTAMPTZ,
    p_user_id UUID,
    p_action TEXT,
    p_details JSONB,
    p_previous TEXT
) RETURNS TEXT
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT encode(sha256(convert_to(
        audit_canonical_v2(p_id, p_created_at, p_user_id, p_action, p_details, p_previous),
        'UTF8')), 'hex')
$$;

-- Lock, read the head, hash and insert in one round trip. The lock key is
-- the one the backend used before, so older replicas still serialise with
-- this during a rolling upgrade.
CREATE OR REPLACE FUNCTION audit_append(p_user_id UUID, p_action TEXT, p_details JSONB)
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    v_previous TEXT;
    v_id BIGINT;
    v_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    PERFORM pg_advisory_xact_lock(x'5354415544495400'::bigint);
    SELECT current_hash INTO v_previous FROM audit_logs ORDER BY id DESC LIMIT 1;
    v_previous := coalesce(v_previous, '');
    v_id := nextval(pg_get_serial_sequence('audit_logs', 'id'));
    INSERT INTO audit_logs
        (id, created_at, user_id, action_type, details, previous_hash, current_hash, hash_version)
    VALUES (
        v_id, v_at, p_user_id, p_action, p_details, v_previous,
        audit_hash_v2(v_id, v_at, p_user_id, p_action, p_details, v_previous), 2
    );
    RETURN v_id;
END
$$;

-- Stops the application, and anything reaching the database through it,
-- from rewriting history. The table owner can still drop the trigger; the
-- chain verifier and its keyed checkpoints cover that case.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS audit_logs_no_change ON audit_logs;
CREATE TRIGGER audit_logs_no_change
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();

-- The last verified head, keyed with a secret the database does not hold.
-- first_v2_id pins where digest checks begin, so rows cannot be relabelled
-- as legacy to escape them.
CREATE TABLE IF NOT EXISTS audit_checkpoints (
    id          BIGSERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_id     BIGINT NOT NULL,
    last_hash   TEXT NOT NULL,
    first_v2_id BIGINT,
    key_id      TEXT NOT NULL,
    mac         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_key ON audit_checkpoints (key_id, id DESC);

-- Connection-name search resolves to ids first, then matches this.
CREATE INDEX IF NOT EXISTS idx_audit_logs_connection_id
    ON audit_logs ((details->>'connection_id'));

-- Substring search. pg_trgm is optional: managed Postgres may not allow it,
-- and search still works without it, only slower.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%); audit search will not be indexed', SQLERRM;
END
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action_trgm
            ON audit_logs USING gin (action_type gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_details_trgm
            ON audit_logs USING gin ((details::text) gin_trgm_ops);
    END IF;
END
$$;
