-- Drop four RDP parameters the native engine will not implement.
--
-- `console`, `initial-program`, `preconnection-id` and
-- `preconnection-blob` are not exposed by the RDP stack the native
-- engine is built on, and upgrading that stack is blocked by a
-- dependency conflict with the SSH engine. They have been removed from
-- the connection editor and from the set of parameters forwarded to
-- guacd, so a row still carrying one would keep a setting nothing acts
-- on and no screen explains.
--
-- Deliberately not written to `audit_logs`: that table is hash-chained,
-- and rows inserted outside the application would break the chain the
-- audit trail depends on. Affected connections are raised as notices so
-- they appear in the migration output instead.
DO $$
DECLARE
    affected TEXT;
BEGIN
    SELECT string_agg(name, ', ' ORDER BY name)
    INTO affected
    FROM connections
    WHERE extra ?| ARRAY['console', 'initial-program',
                         'preconnection-id', 'preconnection-blob'];

    IF affected IS NOT NULL THEN
        RAISE NOTICE 'Dropped unsupported RDP parameters from: %', affected;
    END IF;
END $$;

UPDATE connections
SET extra = extra - 'console'
                  - 'initial-program'
                  - 'preconnection-id'
                  - 'preconnection-blob'
WHERE extra ?| ARRAY['console', 'initial-program',
                     'preconnection-id', 'preconnection-blob'];
