-- ── Rename Connection Groups to Folders ─────────────────────────────────

-- 1. Rename the main table
ALTER TABLE connection_groups RENAME TO connection_folders;

-- 2. Rename columns in connections
ALTER TABLE connections RENAME COLUMN group_id TO folder_id;

-- 3. Rename columns in ad_sync_configs (if applicable)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ad_sync_configs' AND column_name = 'group_id') THEN
        ALTER TABLE ad_sync_configs RENAME COLUMN group_id TO folder_id;
    END IF;
END $$;

-- 4. Rename permission columns in roles
ALTER TABLE roles RENAME COLUMN can_create_connection_groups TO can_create_connection_folders;

-- 5. Rename associated indexes and foreign keys (naming conventions)
ALTER INDEX idx_connection_groups_parent RENAME TO idx_connection_folders_parent;
ALTER INDEX idx_connection_groups_root_name RENAME TO idx_connection_folders_root_name;
ALTER INDEX idx_connections_group RENAME TO idx_connections_folder;

-- Rename foreign key constraints (optional but recommended for clarity)
ALTER TABLE connection_folders RENAME CONSTRAINT connection_groups_parent_id_fkey TO connection_folders_parent_id_fkey;
ALTER TABLE connections RENAME CONSTRAINT connections_group_id_fkey TO connections_folder_id_fkey;

-- If ad_sync_configs exists and has the fkey
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ad_sync_configs_group_id_fkey') THEN
        ALTER TABLE ad_sync_configs RENAME CONSTRAINT ad_sync_configs_group_id_fkey TO ad_sync_configs_folder_id_fkey;
    END IF;
END $$;
