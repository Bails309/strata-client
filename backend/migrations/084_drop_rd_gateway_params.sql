-- Drop the Remote Desktop Gateway parameters.
--
-- The gateway is not used here and the native engine will not implement
-- it: MS-TSGU tunnels RDP inside RPC-over-HTTP, which is a separate
-- connection path rather than a parameter, and there is no way to test
-- one without a Windows Server gateway to point at.
--
-- These five never did anything in any case. `gateway-hostname` and its
-- companions were absent from `is_allowed_guacd_param`, so a value typed
-- into the connection editor was stored and then dropped rather than
-- forwarded, on the guacd path as well as the native one. Removing the
-- fields stops the editor implying a tunnel that was never established.
--
-- As with migrations 082 and 083, deliberately not written to
-- `audit_logs`: that table is hash-chained and rows inserted outside the
-- application would break the chain.
DO $$
DECLARE
    affected TEXT;
BEGIN
    SELECT string_agg(name, ', ' ORDER BY name)
    INTO affected
    FROM connections
    WHERE extra ?| ARRAY['gateway-hostname', 'gateway-port', 'gateway-domain',
                         'gateway-username', 'gateway-password'];

    IF affected IS NOT NULL THEN
        RAISE NOTICE 'Dropped Remote Desktop Gateway parameters from: %. These were never forwarded to guacd, so no connection changes behaviour.', affected;
    END IF;
END $$;

UPDATE connections
SET extra = extra - 'gateway-hostname'
                  - 'gateway-port'
                  - 'gateway-domain'
                  - 'gateway-username'
                  - 'gateway-password'
WHERE extra ?| ARRAY['gateway-hostname', 'gateway-port', 'gateway-domain',
                     'gateway-username', 'gateway-password'];
