-- ── Soft Delete and Granular Permissions ───────────────────────────────

-- 1. Users Soft Delete
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;

-- 2. Granular Permissions on Roles
ALTER TABLE roles ADD COLUMN can_manage_system      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_manage_users       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_manage_connections BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_view_audit_logs    BOOLEAN NOT NULL DEFAULT false;

-- 3. Seed Existing Roles
-- Grant full permissions to existing 'admin' role
UPDATE roles SET 
    can_manage_system = true,
    can_manage_users = true,
    can_manage_connections = true,
    can_view_audit_logs = true
WHERE name = 'admin';

-- Ensure 'user' role remains restricted (already default false, but explicit for clarity)
UPDATE roles SET 
    can_manage_system = false,
    can_manage_users = false,
    can_manage_connections = false,
    can_view_audit_logs = false
WHERE name = 'user';
