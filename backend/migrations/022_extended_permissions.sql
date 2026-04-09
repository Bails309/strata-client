-- ── Extended Granular Permissions ──────────────────────────────────────
-- Adds Guacamole-style creation permissions to roles.

ALTER TABLE roles ADD COLUMN can_create_users              BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_create_user_groups        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_create_connections        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_create_connection_groups  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE roles ADD COLUMN can_create_sharing_profiles   BOOLEAN NOT NULL DEFAULT false;

-- Admin role gets all new creation permissions
UPDATE roles SET
    can_create_users             = true,
    can_create_user_groups       = true,
    can_create_connections       = true,
    can_create_connection_groups = true,
    can_create_sharing_profiles  = true
WHERE name = 'admin';
