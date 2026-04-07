-- ── Credential Profiles & Mappings ────────────────────────────────────
-- Replaces the flat user_credentials table with a two-table design:
--   credential_profiles  – named username+password pairs per user
--   credential_mappings  – many-to-many link between profiles and connections
--
-- A user may have many profiles (e.g. "Domain Admin", "SSH Dev") and map
-- each to one or more connections. Each connection may only have ONE
-- profile mapped per user (enforced by UNIQUE constraint).

CREATE TABLE IF NOT EXISTS credential_profiles (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label               TEXT NOT NULL,
    encrypted_username  BYTEA NOT NULL,
    encrypted_password  BYTEA NOT NULL,
    encrypted_dek       BYTEA NOT NULL,
    nonce               BYTEA NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, label)
);

CREATE TABLE IF NOT EXISTS credential_mappings (
    credential_id   UUID NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
    connection_id   UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    PRIMARY KEY (credential_id, connection_id),
    -- One profile per user per connection (enforced via trigger below)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure a user can only map ONE credential profile to a given connection.
-- The PK alone doesn't prevent two different profiles for the same user+connection.
-- Enforced via trigger:

CREATE OR REPLACE FUNCTION check_single_credential_per_user_connection()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM credential_mappings cm
        JOIN credential_profiles cp ON cp.id = cm.credential_id
        WHERE cm.connection_id = NEW.connection_id
          AND cp.user_id = (SELECT user_id FROM credential_profiles WHERE id = NEW.credential_id)
          AND cm.credential_id != NEW.credential_id
    ) THEN
        RAISE EXCEPTION 'User already has a credential mapped to this connection';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_single_credential_per_user_connection ON credential_mappings;

CREATE TRIGGER trg_single_credential_per_user_connection
    BEFORE INSERT OR UPDATE ON credential_mappings
    FOR EACH ROW
    EXECUTE FUNCTION check_single_credential_per_user_connection();

-- Indices
CREATE INDEX idx_credential_profiles_user ON credential_profiles (user_id);
CREATE INDEX idx_credential_mappings_connection ON credential_mappings (connection_id);

-- ── Migrate existing user_credentials into new tables ────────────────
-- Each old row becomes a profile labelled "Migrated – <connection_name>"
-- with the Strata username as the encrypted_username (re-encrypted).
-- NOTE: We can't re-encrypt the username server-side in pure SQL since
-- it requires Vault Transit. Instead we migrate password data and set
-- encrypted_username to an empty placeholder. Users should update their
-- profiles after migration.

INSERT INTO credential_profiles (id, user_id, label, encrypted_username, encrypted_password, encrypted_dek, nonce, created_at, updated_at)
SELECT
    uc.id,
    uc.user_id,
    'Migrated credentials',
    ''::bytea,                    -- placeholder; user must update username
    uc.encrypted_password,
    uc.encrypted_dek,
    uc.nonce,
    uc.created_at,
    uc.updated_at
FROM user_credentials uc
ON CONFLICT DO NOTHING;

INSERT INTO credential_mappings (credential_id, connection_id, created_at)
SELECT uc.id, uc.connection_id, uc.created_at
FROM user_credentials uc
ON CONFLICT DO NOTHING;

-- Keep user_credentials around for rollback safety; can DROP in a future migration
-- ALTER TABLE user_credentials RENAME TO user_credentials_deprecated;
