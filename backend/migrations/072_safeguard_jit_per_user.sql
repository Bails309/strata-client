-- Per-user opt-in for Safeguard JIT.
--
-- The global master switch lives in `safeguard_config.enabled` and is
-- managed from the Safeguard admin tab. This column adds a granular
-- per-user override so administrators can onboard users into Safeguard
-- one at a time without exposing the JIT credential flows to the rest
-- of the directory.
--
-- Default is FALSE so existing users are *not* automatically enrolled
-- when the appliance is turned on globally — admins must opt them in.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS safeguard_jit_enabled BOOLEAN NOT NULL DEFAULT FALSE;
