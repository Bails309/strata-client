-- Active login sessions tracking.
-- Stores JWT IDs so per-user session visibility and revocation is possible.

CREATE TABLE IF NOT EXISTS active_sessions (
    jti            UUID PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL,
    ip_address     TEXT,
    user_agent     TEXT
);

CREATE INDEX IF NOT EXISTS idx_active_sessions_user_id ON active_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_active_sessions_expires_at ON active_sessions(expires_at);
