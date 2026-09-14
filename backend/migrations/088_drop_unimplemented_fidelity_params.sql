-- Drop the four parameters the native engine will not implement.
--
-- With guacd on the way out, a parameter the native engine ignores is a
-- parameter that will act on nothing at all. Rather than leave four
-- fields in the connection editor that quietly stop meaning anything,
-- they go now -- the same treatment as 084 through 087.
--
-- None is set on any connection here, so nothing changes behaviour.
--
--   timezone (RDP)  MS-RDPBCGR carries a Windows TIME_ZONE_INFORMATION:
--                   a bias, Windows zone names, and DST transition
--                   dates. Mapping an IANA name onto that needs the CLDR
--                   windowsZones table plus transition rules, and a
--                   partial mapping puts the *wrong* time in the session,
--                   which is worse than leaving the host's own. SSH is
--                   unaffected -- it sends TZ as an environment variable
--                   and already honours the parameter.
--
--   enable-touch    Multi-touch rides the RDPEI channel, and there is no
--                   ironrdp crate for it at the version this tree is
--                   pinned to.
--
--   font-name       The rasteriser loads a font from a fixed search path.
--                   Honouring a family name needs fontconfig, which is a
--                   C library, and removing C from the session tier is
--                   the point of that crate. font-size, color-scheme and
--                   scrollback are all honoured and stay.
--
--   terminal-type   Kubernetes only. The exec API has no field for it:
--                   TERM comes from the container image, and the only way
--                   to override it is to wrap the command in `env TERM=`,
--                   which changes what the operator asked to run. SSH
--                   sends it in the PTY request and keeps the parameter.
--
-- As with 082 through 087, deliberately not written to `audit_logs`:
-- that table is hash-chained and rows inserted outside the application
-- would break the chain.
DO $$
DECLARE
    affected TEXT;
BEGIN
    SELECT string_agg(DISTINCT name, ', ' ORDER BY name)
    INTO affected
    FROM connections
    WHERE (protocol = 'rdp' AND extra ?| ARRAY['timezone', 'enable-touch'])
       OR (protocol IN ('ssh', 'kubernetes') AND extra ? 'font-name')
       OR (protocol = 'kubernetes' AND extra ? 'terminal-type');

    IF affected IS NOT NULL THEN
        RAISE NOTICE 'Dropped unimplemented parameters from: %. Sessions keep the host timezone, the default terminal font, and the container''s own TERM.', affected;
    END IF;
END $$;

-- Scoped by protocol: `timezone` and `terminal-type` are honoured on SSH,
-- so only the copies on protocols that cannot act on them are removed.
UPDATE connections
SET extra = extra - 'timezone' - 'enable-touch'
WHERE protocol = 'rdp'
  AND extra ?| ARRAY['timezone', 'enable-touch'];

UPDATE connections
SET extra = extra - 'font-name'
WHERE protocol IN ('ssh', 'kubernetes')
  AND extra ? 'font-name';

UPDATE connections
SET extra = extra - 'terminal-type'
WHERE protocol = 'kubernetes'
  AND extra ? 'terminal-type';
