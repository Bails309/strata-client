-- Drop RemoteApp and RDP microphone input.
--
-- Neither is used, and neither has a path in the native engine: RAIL has
-- no crate on crates.io at all, and the audio-input channel crate pulls
-- a second copy of ironrdp-svc that cannot coexist with the one the
-- connector is pinned to.
--
-- `remote-app`, `remote-app-dir` and `remote-app-args` were another dead
-- form, like the Remote Desktop Gateway fields removed in 084: absent
-- from `is_allowed_guacd_param`, so a value typed in was stored and then
-- dropped rather than forwarded. `enable-audio-input` was genuinely
-- wired to guacd, so that one is a real feature being withdrawn.
--
-- As with 082, 083 and 084, deliberately not written to `audit_logs`:
-- that table is hash-chained and rows inserted outside the application
-- would break the chain.
DO $$
DECLARE
    with_mic TEXT;
BEGIN
    SELECT string_agg(name, ', ' ORDER BY name)
    INTO with_mic
    FROM connections
    WHERE extra ? 'enable-audio-input'
      AND extra ->> 'enable-audio-input' = 'true';

    IF with_mic IS NOT NULL THEN
        RAISE NOTICE 'Microphone redirection withdrawn from: %. These sessions lose audio input.', with_mic;
    END IF;
END $$;

UPDATE connections
SET extra = extra - 'remote-app'
                  - 'remote-app-dir'
                  - 'remote-app-args'
                  - 'enable-audio-input'
WHERE extra ?| ARRAY['remote-app', 'remote-app-dir',
                     'remote-app-args', 'enable-audio-input'];
