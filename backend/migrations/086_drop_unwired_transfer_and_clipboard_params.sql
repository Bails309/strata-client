-- Drop three connection parameters that were never wired to anything.
--
-- `disable-download`, `disable-upload` and `normalize-clipboard` were
-- absent from `is_allowed_guacd_param`, so a value set in the connection
-- editor was stored and then dropped rather than forwarded -- the same
-- dead-form pattern as the Remote Desktop Gateway fields removed in 084
-- and the RemoteApp fields removed in 085. None of the three predates
-- this branch; they have never had an effect on any session.
--
-- The two `disable-*` fields read as file-transfer controls, which is
-- the reason to remove them rather than leave them: a security toggle
-- that silently enforces nothing is worse than one that is not offered.
-- The enforced equivalents are `sftp-disable-download` and
-- `sftp-disable-upload`, which the native SFTP engine honours.
--
-- As with 082 through 085, deliberately not written to `audit_logs`:
-- that table is hash-chained and rows inserted outside the application
-- would break the chain.
DO $$
DECLARE
    affected TEXT;
BEGIN
    SELECT string_agg(name, ', ' ORDER BY name)
    INTO affected
    FROM connections
    WHERE extra ?| ARRAY['disable-download', 'disable-upload', 'normalize-clipboard'];

    IF affected IS NOT NULL THEN
        RAISE NOTICE 'Dropped never-implemented parameters from: %. These were never forwarded to guacd, so no connection changes behaviour. For enforced file-transfer limits use sftp-disable-download / sftp-disable-upload.', affected;
    END IF;
END $$;

UPDATE connections
SET extra = extra - 'disable-download'
                  - 'disable-upload'
                  - 'normalize-clipboard'
WHERE extra ?| ARRAY['disable-download', 'disable-upload', 'normalize-clipboard'];
