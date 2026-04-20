-- ════════════════════════════════════════════════════════════════════════
-- 050: Managed Account Friendly Names
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE password_checkout_requests ADD COLUMN IF NOT EXISTS friendly_name TEXT;
ALTER TABLE user_account_mappings ADD COLUMN IF NOT EXISTS friendly_name TEXT;
ALTER TABLE approval_role_accounts ADD COLUMN IF NOT EXISTS friendly_name TEXT;
