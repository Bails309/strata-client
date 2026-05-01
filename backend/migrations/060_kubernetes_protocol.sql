-- 060: add `kubernetes` to the connection protocol CHECK constraints.
--
-- Mirrors migration 057 (web/vdi). guacd has supported the `kubernetes`
-- protocol since 1.x and our custom guacd image already builds
-- `libguac-client-kubernetes.so` (libwebsockets-dev is in the build deps);
-- this migration is the last gate that prevented operators from creating
-- connections of that protocol via the admin UI.

ALTER TABLE connections
    DROP CONSTRAINT IF EXISTS connections_protocol_check;
ALTER TABLE connections
    ADD CONSTRAINT connections_protocol_check
    CHECK (protocol IN ('rdp', 'ssh', 'vnc', 'web', 'vdi', 'kubernetes'));

ALTER TABLE ad_sync_configs
    DROP CONSTRAINT IF EXISTS ad_sync_configs_protocol_check;
ALTER TABLE ad_sync_configs
    ADD CONSTRAINT ad_sync_configs_protocol_check
    CHECK (protocol IN ('rdp', 'ssh', 'vnc', 'web', 'vdi', 'kubernetes'));
