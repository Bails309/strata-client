-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  Strata Client – Kerberos Keytab Auth for AD Sync               ║
-- ╚═══════════════════════════════════════════════════════════════════╝
-- Adds Kerberos keytab as an alternative to simple (DN + password)
-- LDAP bind for AD sync sources.

ALTER TABLE ad_sync_configs
    ADD COLUMN IF NOT EXISTS auth_method    TEXT NOT NULL DEFAULT 'simple'
        CHECK (auth_method IN ('simple', 'kerberos')),
    ADD COLUMN IF NOT EXISTS keytab_path    TEXT,
    ADD COLUMN IF NOT EXISTS krb5_principal TEXT;
