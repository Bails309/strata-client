-- Backfill deleted folder names in audit_logs for legacy entries
UPDATE audit_logs d
SET details = d.details || jsonb_build_object('name', c.details->>'name')
FROM audit_logs c
WHERE d.action_type = 'connection_folder.deleted'
  AND (d.details->>'name') IS NULL
  AND c.action_type IN ('connection_folder.created', 'connection_folder.updated')
  AND c.details->>'id' = d.details->>'id'
  AND (c.details->>'name') IS NOT NULL;
