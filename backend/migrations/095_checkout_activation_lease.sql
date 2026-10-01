-- Checkout activation is serialised by a lease on the row instead of a
-- session advisory lock, so no connection is held across LDAP and Vault.
ALTER TABLE password_checkout_requests
    ADD COLUMN IF NOT EXISTS activation_lease_until TIMESTAMPTZ;
