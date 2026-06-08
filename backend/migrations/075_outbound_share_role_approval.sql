-- 075: Outbound Share — role-level approval bypass, with per-user override
--
-- Background. Migration 073 added `users.outbound_share_requires_approval`
-- as a per-user boolean (default TRUE). In practice administrators set the
-- same value on every user belonging to a role, so the toggle naturally
-- belongs on the role. This migration lifts the flag onto the role row and
-- makes the per-user column an optional override (NULL = inherit from role).
--
-- Purely additive: no data is dropped, every existing per-user value is
-- preserved as an explicit override, and the effective behaviour on upgrade
-- is unchanged (every user already had an explicit TRUE/FALSE, so the new
-- role default is never consulted for existing rows).

-- ── A. Role-level default ──────────────────────────────────────────────
--
-- Defaults TRUE so newly-created roles match the most restrictive prior
-- behaviour. Admins must explicitly flip the toggle on roles whose members
-- should be allowed to auto-approve outbound exports (subject to the DLP
-- score gate in `services::outbound_shares`).
ALTER TABLE roles
    ADD COLUMN IF NOT EXISTS outbound_share_requires_approval BOOLEAN NOT NULL DEFAULT TRUE;

-- ── B. Per-user override becomes nullable ──────────────────────────────
--
-- NULL means "inherit the current role's `outbound_share_requires_approval`
-- setting"; TRUE/FALSE remains an explicit override. The default is dropped
-- so freshly-created users start in the inherit state and pick up their
-- role's default automatically.
ALTER TABLE users
    ALTER COLUMN outbound_share_requires_approval DROP NOT NULL;
ALTER TABLE users
    ALTER COLUMN outbound_share_requires_approval DROP DEFAULT;
