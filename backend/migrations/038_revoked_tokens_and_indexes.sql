-- Migration 038: Add revoked_tokens table for persistent token revocation,
-- add missing index on recordings.session_id, and clean up stale active_sessions.

-- Persistent token revocation table (survives restarts)
CREATE TABLE IF NOT EXISTS revoked_tokens (
    id          BIGSERIAL PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient pruning of expired entries
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
    ON revoked_tokens (expires_at);

-- Missing index on recordings.session_id (used by UPDATE on tunnel disconnect)
CREATE INDEX IF NOT EXISTS idx_recordings_session_id
    ON recordings (session_id);

-- Clean up any stale active_sessions (rows that were never deleted)
DELETE FROM active_sessions WHERE expires_at < now();
