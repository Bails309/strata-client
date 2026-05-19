CREATE TABLE sso_providers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    issuer_url TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migrate existing SSO configuration if it exists
INSERT INTO sso_providers (name, issuer_url, client_id, client_secret)
SELECT
    'SSO (Default)' as name,
    (SELECT value FROM system_settings WHERE key = 'sso_issuer_url') as issuer_url,
    (SELECT value FROM system_settings WHERE key = 'sso_client_id') as client_id,
    (SELECT value FROM system_settings WHERE key = 'sso_client_secret') as client_secret
WHERE EXISTS (
    SELECT 1 FROM system_settings WHERE key = 'sso_issuer_url' AND value != ''
);

-- Delete old keys
DELETE FROM system_settings WHERE key IN ('sso_issuer_url', 'sso_client_id', 'sso_client_secret');
