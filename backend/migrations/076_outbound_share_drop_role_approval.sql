-- 076: Remove role-level Outbound-Share approval setting
--
-- Migration 075 lifted the approval-required flag onto the role row and
-- made the per-user column a nullable override. UX review on the role
-- editor concluded the role should expose only an on/off feature gate
-- ("Use Outbound Quick Share") and that approval should always be
-- required by default — opt-out is granted per-user, never per-role.
--
-- This migration walks the role layer back out: the role column is
-- dropped and the per-user `users.outbound_share_requires_approval`
-- column remains as the only override surface. After this migration,
-- NULL on the user row means "use the system default (require
-- approval)" rather than "inherit the role default".
--
-- Behaviour preservation: any user currently inheriting a FALSE role
-- default (i.e. members of a role that was flipped to auto-approve in
-- 075 and who never had a per-user override set) would otherwise flip
-- to "required" the moment the role column disappears. Backfill those
-- rows with an explicit FALSE first so their effective approval policy
-- is unchanged across the upgrade. Users with an explicit per-user
-- value (TRUE or FALSE) are untouched.

UPDATE users u
SET outbound_share_requires_approval = FALSE
FROM roles r
WHERE u.role_id = r.id
  AND u.outbound_share_requires_approval IS NULL
  AND r.outbound_share_requires_approval = FALSE;

ALTER TABLE roles
    DROP COLUMN IF EXISTS outbound_share_requires_approval;
