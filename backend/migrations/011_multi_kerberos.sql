-- ── Multiple Kerberos Realms ─────────────────────────────────────────
-- Replaces the flat system_settings approach with a proper table so
-- multiple AD domains / forests can be configured simultaneously.
-- The krb5.conf is regenerated from all rows on every change.

CREATE TABLE IF NOT EXISTS kerberos_realms (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    realm           TEXT NOT NULL UNIQUE,
    kdc_servers     TEXT NOT NULL DEFAULT '',      -- comma-separated list of KDCs
    admin_server    TEXT NOT NULL DEFAULT '',
    ticket_lifetime TEXT NOT NULL DEFAULT '10h',
    renew_lifetime  TEXT NOT NULL DEFAULT '7d',
    is_default      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migrate existing single-realm config into the new table (if configured)
INSERT INTO kerberos_realms (realm, kdc_servers, admin_server, ticket_lifetime, renew_lifetime, is_default)
SELECT
    s_realm.value,
    COALESCE(s_kdc.value, ''),
    COALESCE(s_admin.value, ''),
    COALESCE(s_ticket.value, '10h'),
    COALESCE(s_renew.value, '7d'),
    true
FROM system_settings s_realm
LEFT JOIN system_settings s_kdc    ON s_kdc.key    = 'kerberos_kdc'
LEFT JOIN system_settings s_admin  ON s_admin.key  = 'kerberos_admin_server'
LEFT JOIN system_settings s_ticket ON s_ticket.key = 'kerberos_ticket_lifetime'
LEFT JOIN system_settings s_renew  ON s_renew.key  = 'kerberos_renew_lifetime'
WHERE s_realm.key = 'kerberos_realm'
  AND s_realm.value != ''
ON CONFLICT (realm) DO NOTHING;
