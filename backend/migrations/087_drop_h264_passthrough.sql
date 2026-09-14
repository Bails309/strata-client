-- Drop the H.264 / AVC passthrough toggle.
--
-- The native engine has no RDPGFX pipeline, so `enable-h264` would
-- become another setting that is stored, shown in the editor, and acts
-- on nothing the moment guacd leaves the deployment -- the same dead
-- form removed in 084, 085 and 086. Removing it now keeps the editor
-- honest rather than waiting for the daemon to go.
--
-- Nothing is withdrawn in practice: the parameter defaulted to false,
-- and no connection had it enabled. On the guacd path `video/h264` is
-- no longer advertised at all, which is what every connection here was
-- already getting.
--
-- Not abandoned on a whim. Implementing it natively is a real option:
-- ironrdp-pdu 0.6 -- the version this tree is pinned to -- already
-- carries the MS-RDPEGFX PDUs including Avc420BitmapStream,
-- Avc444BitmapStream and the AVC codec ids, and the browser client
-- already understands the custom `h264` instruction. What is missing is
-- the channel orchestration: ironrdp-egfx needs pdu 0.9 / dvc 0.8 /
-- core 0.2, beyond the pin held by the picky/russh conflict, so it
-- would have to be written over ironrdp-dvc 0.4.
--
-- It is dropped rather than built because there is no way to test it
-- here. H.264 requires the *server* to encode -- xrdp built with x264,
-- or Windows with an AVC hardware encoder -- and no target in this
-- deployment does. An untestable video path in a privileged access
-- gateway is not worth the exposure, and measurement says the gain is
-- small anyway: the native encoder currently runs at 0.077 bytes per
-- pixel, roughly 39:1, about 230 kbps for an active desktop.
--
-- As with 082 through 086, deliberately not written to `audit_logs`:
-- that table is hash-chained and rows inserted outside the application
-- would break the chain.
DO $$
DECLARE
    affected TEXT;
BEGIN
    SELECT string_agg(name, ', ' ORDER BY name)
    INTO affected
    FROM connections
    WHERE extra ? 'enable-h264'
      AND extra ->> 'enable-h264' = 'true';

    IF affected IS NOT NULL THEN
        RAISE NOTICE 'H.264 passthrough withdrawn from: %. These sessions fall back to the standard image pipeline.', affected;
    END IF;
END $$;

UPDATE connections
SET extra = extra - 'enable-h264'
WHERE extra ? 'enable-h264';
