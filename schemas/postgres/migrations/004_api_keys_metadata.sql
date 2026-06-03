-- 004_api_keys_metadata.sql
--
-- Extend api_keys with the columns the dashboard's key-management UI needs:
--
--   key_prefix  — public preview shown in the list (e.g. "sc_live_a1b2c3...").
--                 We CAN'T show the raw key after creation (we only store the
--                 hash), but a prefix is enough for the user to identify which
--                 key is which. Convention: first 12 chars of the raw token.
--   last_used_at — surfaced in the list as "last used 3m ago". Auth middleware
--                  bumps this on every successful resolve. Bounded write rate
--                  via Postgres UPDATE coalescing — we don't write on every
--                  request, only when more than 60s have passed since the
--                  previous stamp (handled in the auth path, not here).
--
-- Both columns are nullable so that existing rows (from before this migration)
-- don't need a backfill — the UI just renders "—" when null.
--
-- The original idx_api_keys_active index stays as-is.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS key_prefix   TEXT,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Listing keys per-org is the dashboard's only read path that isn't by hash,
-- and it's small (handful of keys per org), but the index keeps the page
-- snappy as multi-tenant scale grows.
CREATE INDEX IF NOT EXISTS idx_api_keys_org_created_at
  ON api_keys (org_id, created_at DESC);
