-- SEC-06: bind a linked OIDC subject to the issuer that asserted it.
-- A subject is only unique within its issuer, so matching on `sub` alone lets
-- a second configured provider claim an account. Existing links have NULL
-- here and are bound to the issuer of their next successful SSO login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_issuer TEXT;
