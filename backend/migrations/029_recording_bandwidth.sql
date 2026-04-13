-- Copyright 2026 Strata Client Contributors
-- SPDX-License-Identifier: Apache-2.0

-- Track bandwidth per recording for historical analysis.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS bytes_from_guacd BIGINT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS bytes_to_guacd BIGINT;
