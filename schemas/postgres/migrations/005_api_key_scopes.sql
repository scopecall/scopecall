-- 005_api_key_scopes.sql
--
-- Adds a `scopes TEXT[]` column to api_keys so the Settings → API Keys
-- flow can mint keys narrower than "everything". Round-7 review caught
-- that sc_live_* keys were accepted everywhere — a key intended for SDK
-- ingest could also read traces/costs/prompts. That's true today and
-- this column is the structured way to fix it forward.
--
-- Scope vocabulary (v1):
--   - ingest:write   — POST /v1/ingest, accepted by the Rust ingest service.
--   - traces:read    — Bearer-token auth into the Go API for the dashboard
--                      read endpoints (traces / cost / prompts / etc.).
--
-- NULL semantics: a NULL scopes column means "legacy key, all scopes
-- allowed." This is critical for upgrade-install back-compat — keys
-- minted before the column existed must keep working until the operator
-- consciously narrows them.
--
-- New keys from the dashboard default to ['ingest:write'] only. Operators
-- who want a read-capable key tick a checkbox in the UI which adds
-- 'traces:read'.
--
-- We use TEXT[] (not a separate api_key_scopes table) because:
--   (a) the cardinality is tiny — at most a handful of scopes per key,
--   (b) every auth path needs the full scope set for the key (no joins),
--   (c) GIN index on scopes makes the membership check fast if it ever
--       matters (it won't at v1 traffic, but the index is free).

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scopes TEXT[];

-- GIN index supports the `scopes @> '{traces:read}'` style membership
-- queries the Go middleware will run on every Bearer-token request. At
-- v1 cardinality this is overkill but it's a tiny cost and rules out a
-- future surprise.
CREATE INDEX IF NOT EXISTS idx_api_keys_scopes
  ON api_keys USING GIN (scopes);
