-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  Strata Client – Initial Schema                                  ║
-- ╚═══════════════════════════════════════════════════════════════════╝

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── System Settings (key-value store) ────────────────────────────────
CREATE TABLE system_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default settings
INSERT INTO system_settings (key, value) VALUES
    ('sso_enabled',              'false'),
    ('sso_issuer_url',           ''),
    ('sso_client_id',            ''),
    ('sso_client_secret',        ''),
    ('kerberos_enabled',         'false'),
    ('kerberos_realm',           ''),
    ('kerberos_kdc',             ''),
    ('kerberos_admin_server',    ''),
    ('recordings_enabled',       'false'),
    ('recordings_retention_days','30');

-- ── Roles ────────────────────────────────────────────────────────────
CREATE TABLE roles (
    id   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO roles (name) VALUES ('admin'), ('user');

-- ── Users ────────────────────────────────────────────────────────────
CREATE TABLE users (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sub        TEXT UNIQUE,              -- OIDC subject claim
    username   TEXT NOT NULL UNIQUE,
    role_id    UUID NOT NULL REFERENCES roles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Connections ──────────────────────────────────────────────────────
CREATE TABLE connections (
    id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name     TEXT NOT NULL,
    protocol TEXT NOT NULL CHECK (protocol IN ('rdp', 'ssh', 'vnc')),
    hostname TEXT NOT NULL,
    port     INT  NOT NULL DEFAULT 3389,
    domain   TEXT,
    extra    JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Role ↔ Connection mapping ────────────────────────────────────────
CREATE TABLE role_connections (
    role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, connection_id)
);

-- ── User Credentials (envelope-encrypted) ────────────────────────────
CREATE TABLE user_credentials (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id    UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    encrypted_password BYTEA NOT NULL,       -- AES-256-GCM ciphertext
    encrypted_dek      BYTEA NOT NULL,       -- Vault-wrapped DEK
    nonce              BYTEA NOT NULL,       -- GCM nonce (12 bytes)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, connection_id)
);

-- ── Immutable Audit Logs (hash-chained) ──────────────────────────────
CREATE TABLE audit_logs (
    id            BIGSERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id       UUID REFERENCES users(id),
    action_type   TEXT NOT NULL,
    details       JSONB NOT NULL DEFAULT '{}',
    previous_hash TEXT NOT NULL DEFAULT '',
    current_hash  TEXT NOT NULL
);

-- Enforce append-only: revoke UPDATE/DELETE on audit_logs
-- (applied via a separate role in production; documented here for intent)
COMMENT ON TABLE audit_logs IS 'Immutable append-only audit trail. Grant INSERT, SELECT only.';

-- Indices
CREATE INDEX idx_audit_logs_user      ON audit_logs (user_id);
CREATE INDEX idx_audit_logs_action    ON audit_logs (action_type);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs (created_at);
CREATE INDEX idx_user_credentials_user ON user_credentials (user_id);
CREATE INDEX idx_connections_protocol  ON connections (protocol);
