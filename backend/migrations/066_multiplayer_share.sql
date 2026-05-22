-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  Strata Client – Multiplayer / Co-Pilot share extension          ║
-- ║                                                                  ║
-- ║  Extends connection_shares with the multiplayer toggle and       ║
-- ║  capacity/feature flags, and adds a per-participant audit row    ║
-- ║  written on join/leave of a co-pilot room.                       ║
-- ║                                                                  ║
-- ║  Forward-compatible: every new column has a default that         ║
-- ║  matches the pre-1.9.6 behaviour, so existing share rows remain  ║
-- ║  pure "view"/"control" single-viewer links.                      ║
-- ╚═══════════════════════════════════════════════════════════════════╝

ALTER TABLE connection_shares
  ADD COLUMN IF NOT EXISTS multiplayer       BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS max_participants  SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS allow_chat        BOOLEAN  NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS allow_audio       BOOLEAN  NOT NULL DEFAULT FALSE;

-- Sanity-cap max_participants at 6 (matches MAX_PARTICIPANTS in
-- backend/src/services/co_pilot.rs). The application layer also
-- clamps incoming values, but the DB constraint defends against
-- direct-SQL writes from an admin script.
ALTER TABLE connection_shares
  ADD CONSTRAINT connection_shares_max_participants_chk
  CHECK (max_participants BETWEEN 1 AND 6);

-- Per-participant audit row: minimal, no chat content, ephemeral
-- columns are populated on join and left_at is stamped on leave.
CREATE TABLE IF NOT EXISTS share_participant_audit (
    id           BIGSERIAL PRIMARY KEY,
    share_id     UUID         NOT NULL REFERENCES connection_shares(id) ON DELETE CASCADE,
    pid          UUID         NOT NULL,
    display_name TEXT         NOT NULL,
    is_owner     BOOLEAN      NOT NULL DEFAULT FALSE,
    joined_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    left_at      TIMESTAMPTZ,
    client_ip    TEXT,
    user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS share_participant_audit_share_idx
    ON share_participant_audit(share_id);

CREATE INDEX IF NOT EXISTS share_participant_audit_pid_idx
    ON share_participant_audit(pid);
