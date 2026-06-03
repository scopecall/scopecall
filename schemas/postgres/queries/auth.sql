-- name: GetActiveAPIKey :one
-- Hot-path lookup used by the Go API auth middleware on every Bearer-
-- token request. Returns the org_id, the key's id (so we can bump
-- last_used_at), and the key's scopes (so the middleware can gate the
-- request on traces:read for read endpoints).
SELECT org_id, id AS key_id, scopes
FROM api_keys
WHERE key_hash = $1
  AND revoked = false
LIMIT 1;

-- name: GetOrgByID :one
SELECT id, name, created_at
FROM orgs
WHERE id = $1
LIMIT 1;
