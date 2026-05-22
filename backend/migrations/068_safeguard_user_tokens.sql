-- ── Safeguard JIT: per-user browser SSO mode ─────────────────────────
-- The original per_user_oidc value was a placeholder for "deferred —
-- federation login". We now ship a working implementation that mirrors
-- what the Safeguard-PS module's `Connect-Safeguard -Browser` flow does:
-- the user authenticates against Safeguard's RSTS via their own browser
-- (federation provider, e.g. extf161), Strata stores the resulting API
-- token Vault-sealed and uses it for that user's JIT checkouts.
--
-- Rename the enum value so old "per_user_oidc" rows lose their
-- "deferred" connotation and align with the new behaviour.
ALTER TABLE safeguard_config DROP CONSTRAINT IF EXISTS safeguard_config_auth_mode_check;

UPDATE safeguard_config
SET auth_mode = 'per_user_browser'
WHERE auth_mode = 'per_user_oidc';

ALTER TABLE safeguard_config
    ALTER COLUMN auth_mode SET DEFAULT 'per_user_browser';

ALTER TABLE safeguard_config
    ADD CONSTRAINT safeguard_config_auth_mode_check
        CHECK (auth_mode IN ('per_user_browser','a2a','hybrid'));

-- ── safeguard_user_tokens ───────────────────────────────────────────
-- One row per (user, appliance) — keyed on user_id alone since the
-- appliance is a singleton. Stores the user's Safeguard API access
-- token Vault-sealed (envelope: ciphertext + per-row DEK + nonce, same
-- shape as credential_profiles encryption).
CREATE TABLE IF NOT EXISTS safeguard_user_tokens (
    user_id        UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ciphertext     BYTEA       NOT NULL,
    encrypted_dek  BYTEA       NOT NULL,
    nonce          BYTEA       NOT NULL,
    -- Safeguard tokens are 15-minute lived by default. We persist
    -- expires_at so the API can answer `/status` and `jit_checkout`
    -- can fast-fail with "signin_required" instead of round-tripping
    -- to the appliance for an inevitable 401.
    expires_at     TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_safeguard_user_tokens_expires
    ON safeguard_user_tokens (expires_at);
