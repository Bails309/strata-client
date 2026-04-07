-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  Strata Client – Connection Sharing                              ║
-- ╚═══════════════════════════════════════════════════════════════════╝

-- Temporary share links for active connections.
-- Shares expire when the owning user disconnects or can be revoked manually.
CREATE TABLE connection_shares (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_token   TEXT NOT NULL UNIQUE,
    read_only     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ,
    revoked       BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_shares_token ON connection_shares(share_token) WHERE NOT revoked;
