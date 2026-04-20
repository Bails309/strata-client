-- ════════════════════════════════════════════════════════════════════════
-- 051: Emergency Approval Bypass
-- ════════════════════════════════════════════════════════════════════════
--
-- Allows a user who normally requires approval to mark a password checkout
-- request as an "emergency" which bypasses the approval workflow and
-- releases the password immediately (as if they had can_self_approve set).
--
-- Gated per AD sync config via pm_allow_emergency_bypass so admins can
-- disable the break-glass feature where it is not appropriate.
-- Every bypass use is recorded on the request row and in the audit log.

ALTER TABLE ad_sync_configs
    ADD COLUMN IF NOT EXISTS pm_allow_emergency_bypass BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE password_checkout_requests
    ADD COLUMN IF NOT EXISTS emergency_bypass BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_password_checkout_requests_emergency_bypass
    ON password_checkout_requests (emergency_bypass)
    WHERE emergency_bypass = true;
