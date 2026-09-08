-- Drop RDP drive and printer redirection.
--
-- File transfer is moving to a single native SFTP implementation shared
-- by every protocol, so the RDPDR channel has nothing left to carry:
-- an RDP connection that needs file transfer now enables SFTP like any
-- other. Printer redirection went with it -- it rides the same channel
-- and was the only other thing on it.
--
-- The file browser, the outbound-share approval workflow and its AV
-- scanning are unaffected: they hang off the filesystem object, which
-- SFTP still provides.
--
-- As with migration 082, deliberately not written to `audit_logs`: that
-- table is hash-chained and rows inserted outside the application would
-- break the chain.
DO $$
DECLARE
    affected TEXT;
BEGIN
    SELECT string_agg(name, ', ' ORDER BY name)
    INTO affected
    FROM connections
    WHERE extra ?| ARRAY['enable-drive', 'drive-name', 'drive-path',
                         'create-drive-path', 'enable-printing', 'printer-name'];

    IF affected IS NOT NULL THEN
        RAISE NOTICE 'Dropped drive/printer redirection from: %. Enable SFTP on these connections to keep file transfer.', affected;
    END IF;
END $$;

UPDATE connections
SET extra = extra - 'enable-drive'
                  - 'drive-name'
                  - 'drive-path'
                  - 'create-drive-path'
                  - 'enable-printing'
                  - 'printer-name'
WHERE extra ?| ARRAY['enable-drive', 'drive-name', 'drive-path',
                     'create-drive-path', 'enable-printing', 'printer-name'];
