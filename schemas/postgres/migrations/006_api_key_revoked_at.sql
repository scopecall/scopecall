-- 006_api_key_revoked_at.sql
--
-- Adds `revoked_at TIMESTAMPTZ` to api_keys so we can:
--   1. Show "revoked 3d ago" / "auto-delete in 27d" in the dashboard.
--   2. Run a periodic cleanup that permanently deletes revoked keys older
--      than API_KEY_RETENTION_DAYS (default 30) — keeps the audit list
--      bounded without losing recent forensic state.
--
-- Why a separate column (not just `created_at`):
-- The cleanup must key on revocation time, not creation time. A key minted
-- a year ago that's revoked today should be retained for the full window
-- starting now, not deleted immediately because it's "old". `created_at`
-- can't answer "when was this revoked"; the new column can.
--
-- NULL semantics on existing rows: NULL means "either still active OR a
-- pre-migration revoked row whose revocation time we don't know." The
-- cleanup query explicitly filters `revoked_at IS NOT NULL` so those
-- legacy revoked rows are never auto-deleted — operators can clean them
-- manually if they want.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Cleanup goroutine queries the table by (revoked = TRUE, revoked_at <
-- threshold). The partial index keeps that scan cheap even with many
-- historical revoked rows.
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at
  ON api_keys (revoked_at)
  WHERE revoked = TRUE AND revoked_at IS NOT NULL;
