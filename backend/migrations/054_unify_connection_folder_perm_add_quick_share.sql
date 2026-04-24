-- 054_unify_connection_folder_perm_add_quick_share.sql
--
-- Two linked RBAC refinements:
--
-- 1. **Unify `can_create_connections` and `can_create_connection_folders`**
--    into a single role flag.  Operationally these two permissions always
--    travelled together (the folder UI only exists inside the Access tab
--    so any role that can create connections also needs folders and vice
--    versa).  Splitting them confused admins.  We keep
--    `can_create_connections` as the unified flag and drop the folder one.
--
-- 2. **Add `can_use_quick_share`** — governs the Quick Share "upload file
--    for temporary download" quick-action button.  Quick Share is a
--    user-level feature (not an admin privilege), so it does NOT
--    contribute to the `has_any_admin_permission` check.  Existing roles
--    receive `true` so current users keep their ability, and admins can
--    then tighten individual roles.

BEGIN;

-- (1) Merge folder-create into connection-create
UPDATE roles
   SET can_create_connections = can_create_connections OR can_create_connection_folders;
ALTER TABLE roles DROP COLUMN can_create_connection_folders;

-- (2) Add Quick Share, enable on all existing roles for a non-breaking upgrade
ALTER TABLE roles ADD COLUMN can_use_quick_share BOOLEAN NOT NULL DEFAULT false;
UPDATE roles SET can_use_quick_share = true;

COMMIT;
