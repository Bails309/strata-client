-- v2.2.0 roadmap prune: drop status overrides for items removed from the
-- in-app roadmap because they have shipped.
--   workflows-quick-share-outbound  shipped v1.11.0 (Outbound Quick-Share)
--   protocols-ironrdp-upgrade       shipped (Tokio-native IronRDP sessions)
-- A missing or non-JSON value is left untouched rather than failing the boot.
DO $$
BEGIN
    UPDATE system_settings
       SET value = (value::jsonb - 'workflows-quick-share-outbound' - 'protocols-ironrdp-upgrade')::text,
           updated_at = now()
     WHERE key = 'roadmap_statuses'
       AND (value::jsonb ? 'workflows-quick-share-outbound' OR value::jsonb ? 'protocols-ironrdp-upgrade');
EXCEPTION
    WHEN invalid_text_representation THEN
        RAISE NOTICE 'roadmap_statuses is not valid JSON; left unchanged';
END $$;
