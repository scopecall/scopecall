-- api_keys.sql — sqlc queries for the dashboard's key management UI.
--
-- Auth middleware uses GetActiveAPIKey (in auth.sql) on every request, so we
-- deliberately keep these listing/admin queries out of the hot path: they're
-- only called from the settings page or the periodic cleanup goroutine.

-- name: ListAPIKeys :many
-- Returns every key for an org, newest first. Includes revoked keys so the
-- dashboard's Revoked tab can show audit history (with an auto-delete
-- countdown derived from revoked_at).
SELECT id, org_id, name, key_prefix, scopes, revoked, created_at, last_used_at, revoked_at
FROM api_keys
WHERE org_id = $1
ORDER BY created_at DESC;

-- name: CreateAPIKey :one
-- Insert a new key. The raw token is generated and hashed by the caller —
-- this query only sees the hash + the public prefix. RETURNING gives us the
-- generated id + created_at so the API response is correct without a second
-- round trip. scopes is NOT NULL on create (the handler always passes the
-- requested scope set; never the legacy NULL "all-scopes" sentinel).
INSERT INTO api_keys (id, org_id, key_hash, key_prefix, name, scopes)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, org_id, name, key_prefix, scopes, revoked, created_at, last_used_at, revoked_at;

-- name: RevokeAPIKey :one
-- Soft-delete: flip the revoked flag AND stamp revoked_at. The cleanup
-- goroutine uses revoked_at (not created_at) to decide what's old enough to
-- permanently delete, so a key minted a year ago and revoked today gets the
-- full retention window starting now. Returns key_hash so the handler can
-- DEL key:<hash> from Redis for immediate revocation (Round-7 review).
-- Scoped by org_id so cross-org guessing can't revoke another tenant's keys.
UPDATE api_keys
SET revoked    = TRUE,
    revoked_at = NOW()
WHERE id = $1 AND org_id = $2 AND revoked = FALSE
RETURNING key_hash;

-- name: TouchAPIKeyLastUsed :exec
-- Bumps last_used_at to now() if the row's previous stamp is older than the
-- coalesce-window (60s). Auth middleware calls this opportunistically — it's
-- a write on the hot path, but coalescing keeps the write rate bounded
-- regardless of request rate.
UPDATE api_keys
SET last_used_at = NOW()
WHERE id = $1
  AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '60 seconds');

-- name: DeleteOldRevokedAPIKeys :execrows
-- Permanently delete revoked keys older than the retention window.
-- Filters on revoked_at IS NOT NULL so legacy pre-migration revoked rows
-- (with a NULL revoked_at) are never auto-cleaned — operators must clean
-- those by hand if they want.
--
-- $1 is the retention cutoff timestamp (i.e. NOW() - INTERVAL 'N days');
-- the cutoff is computed in Go so the goroutine config knob applies
-- cleanly without a sqlc-side parameter type for INTERVAL.
DELETE FROM api_keys
WHERE revoked = TRUE
  AND revoked_at IS NOT NULL
  AND revoked_at < $1;
