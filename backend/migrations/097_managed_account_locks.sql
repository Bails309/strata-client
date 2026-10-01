-- One password operation per managed account at a time (SEC-09). Replaces
-- the per-checkout activation lease from 095.
CREATE TABLE IF NOT EXISTS managed_account_locks (
    account_key  TEXT PRIMARY KEY,
    operation_id UUID NOT NULL,
    operation    TEXT NOT NULL,
    locked_until TIMESTAMPTZ NOT NULL
);

-- The password an activation is about to set, sealed, from just before the
-- AD reset until the checkout is committed.
ALTER TABLE password_checkout_requests
    ADD COLUMN IF NOT EXISTS pending_secret BYTEA,
    ADD COLUMN IF NOT EXISTS pending_dek    BYTEA,
    ADD COLUMN IF NOT EXISTS pending_nonce  BYTEA,
    DROP COLUMN IF EXISTS activation_lease_until;
