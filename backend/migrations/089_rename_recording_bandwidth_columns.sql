-- Rename the recording bandwidth columns off the removed daemon.
--
-- 029 named these after guacd because guacd was the thing on the other
-- end of the socket. It isn't any more, so the names now describe a
-- component that does not exist and get read as though they were about
-- a proxy hop rather than the browser.
--
-- The direction is unchanged and the values are untouched:
--   bytes_from_guacd -> bytes_down   server -> client (towards the browser)
--   bytes_to_guacd   -> bytes_up     client -> server (towards the target)
--
-- Guarded on the old name so a database already carrying the new one --
-- or one where 029 never ran -- applies this as a no-op rather than
-- erroring. Postgres has no ALTER TABLE ... RENAME COLUMN IF EXISTS.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recordings' AND column_name = 'bytes_from_guacd'
    ) THEN
        ALTER TABLE recordings RENAME COLUMN bytes_from_guacd TO bytes_down;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'recordings' AND column_name = 'bytes_to_guacd'
    ) THEN
        ALTER TABLE recordings RENAME COLUMN bytes_to_guacd TO bytes_up;
    END IF;
END $$;

-- A database that never ran 029 still needs the columns to exist.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS bytes_down BIGINT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS bytes_up BIGINT;
