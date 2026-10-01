-- Recording outcome (SEC-16). `recording` while the session runs;
-- `complete` once finalised intact; `incomplete` when it stopped early or
-- its tail may be lost; `failed` when nothing usable was recorded.
ALTER TABLE recordings
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'
        CHECK (status IN ('recording', 'complete', 'incomplete', 'failed')),
    ADD COLUMN IF NOT EXISTS failure TEXT;

-- Rows never finalised before this migration: the session crashed, never
-- connected, or the backend stopped under it.
UPDATE recordings
SET status = 'incomplete',
    failure = 'never finalised'
WHERE duration_secs IS NULL;
