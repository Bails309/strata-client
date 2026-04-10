-- Copyright 2026 Strata Client Contributors
-- SPDX-License-Identifier: Apache-2.0

-- Create recordings table to track session recording metadata
CREATE TABLE IF NOT EXISTS recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL UNIQUE, -- The NVR session ID used for the filename
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    connection_name TEXT NOT NULL, -- Cached for historical browsing
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL, -- Cached for historical browsing
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_secs INTEGER, -- Populated after session terminates
    storage_path TEXT NOT NULL, -- Filename or blob key
    storage_type TEXT NOT NULL CHECK (storage_type IN ('local', 'azure')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for searching history
CREATE INDEX idx_recordings_user_id ON recordings(user_id);
CREATE INDEX idx_recordings_connection_id ON recordings(connection_id);
CREATE INDEX idx_recordings_started_at ON recordings(started_at DESC);
