-- Copyright 2026 Strata Client Contributors
-- SPDX-License-Identifier: Apache-2.0

-- Fix: audit_logs.user_id has no ON DELETE action (defaults to RESTRICT),
-- which blocks hard-deletion of soft-deleted users after the grace period.
-- Change to SET NULL so the audit trail is preserved with a null actor.

ALTER TABLE audit_logs
    DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey,
    ADD CONSTRAINT audit_logs_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
