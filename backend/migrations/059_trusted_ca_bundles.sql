-- 059_trusted_ca_bundles.sql
--
-- Reusable trust roots for the web-session kiosk. Admins upload a PEM
-- bundle (one or more CA certs) once, give it a label, and any web
-- connection in the catalog can pick it from a dropdown to trust
-- self-signed / internal-CA TLS endpoints without using
-- --ignore-certificate-errors.
--
-- The PEM is stored verbatim. Validation happens at upload time
-- (parse + leaf-vs-CA basicConstraints check) so a malformed file
-- can't poison the database.
--
-- Per-session NSS DB import:
--   At kiosk launch, services::web_runtime fetches the row, materialises
--   it under <user-data-dir>/.pki/nssdb via certutil, and lets Chromium
--   pick it up automatically. The bundle never lands on disk outside
--   the ephemeral profile directory.

CREATE TABLE IF NOT EXISTS trusted_ca_bundles (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    description TEXT        NOT NULL DEFAULT '',
    pem         TEXT        NOT NULL,
    -- Cached metadata extracted from the PEM at upload time so the
    -- admin UI can render expiry / subject info without re-parsing on
    -- every list call. NULL for bundles imported before this column
    -- was populated.
    subject     TEXT,
    not_after   TIMESTAMPTZ,
    fingerprint TEXT,            -- SHA-256, hex, lowercase, ':'-separated
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  UUID            REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trusted_ca_bundles_name_idx
    ON trusted_ca_bundles (LOWER(name));
