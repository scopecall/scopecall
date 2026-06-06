package handler

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/scopecall/services-go/api/internal/db"
	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
)

// APIKeysServer exposes the CRUD endpoints that back the dashboard's
// Settings → API Keys page.
//
// Why hand-wired (not generated): the strict OpenAPI server is a heavyweight
// surface — adding three endpoints means regenerating ~200 lines into
// api.gen.go and re-syncing the TypeScript client. These endpoints are
// internal dashboard ↔ API plumbing (no third-party SDK consumes them), so
// the same shortcut /breakdown, /trace-tree, /saved-views took applies here.
type APIKeysServer struct {
	Q     *db.Queries
	Redis *redis.Client
}

// Scope vocabulary (kept in sync with schemas/postgres/migrations/005_api_key_scopes.sql
// and services-rust/ingest/src/auth.rs):
//   - ingest:write — POST to /v1/ingest (Rust ingest service)
//   - traces:read  — read the Go API's dashboard endpoints
const (
	scopeIngestWrite = "ingest:write"
	scopeTracesRead  = "traces:read"
)

// validScopes are the only scopes the create endpoint will accept. New
// scopes must be added here AND in the Rust ingest + Go middleware
// allowlists. Unknown scopes silently dropped would create the worst kind
// of UX confusion ("I asked for foo:bar and the key has no scopes?").
var validScopes = map[string]bool{
	scopeIngestWrite: true,
	scopeTracesRead:  true,
}

// keyView is the JSON shape every list-row + create response uses.
// Notably absent: key_hash. Hashes never leave the database.
type keyView struct {
	ID         string   `json:"id"`
	Name       *string  `json:"name"`
	KeyPrefix  *string  `json:"key_prefix"`
	Scopes     []string `json:"scopes"`
	Revoked    bool     `json:"revoked"`
	CreatedAt  string   `json:"created_at"`
	LastUsedAt *string  `json:"last_used_at"`
	// RevokedAt is set when the key flips to revoked = true and powers the
	// dashboard's "revoked Nd ago / auto-delete in Md" countdown. NULL on
	// active keys and on legacy revoked rows that predate the column.
	RevokedAt *string `json:"revoked_at"`
}

func rowToView(r db.ListAPIKeysRow) keyView {
	v := keyView{
		ID:        r.ID,
		Scopes:    r.Scopes,
		Revoked:   r.Revoked,
		CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339),
	}
	// JSON null vs empty array: legacy keys (NULL in PG) deserialize to a
	// nil slice. We surface them as an empty array so the client can rely
	// on `.length === 0` meaning "legacy / all-scopes" and treat that as
	// a UI hint to display "all" instead of an empty pill cluster.
	if v.Scopes == nil {
		v.Scopes = []string{}
	}
	if r.Name.Valid {
		v.Name = &r.Name.String
	}
	if r.KeyPrefix.Valid {
		v.KeyPrefix = &r.KeyPrefix.String
	}
	if r.LastUsedAt.Valid {
		s := r.LastUsedAt.Time.UTC().Format(time.RFC3339)
		v.LastUsedAt = &s
	}
	if r.RevokedAt.Valid {
		s := r.RevokedAt.Time.UTC().Format(time.RFC3339)
		v.RevokedAt = &s
	}
	return v
}

func createRowToView(r db.CreateAPIKeyRow) keyView {
	// Both rows are structurally identical; reuse the formatter.
	return rowToView(db.ListAPIKeysRow{
		ID:         r.ID,
		OrgID:      r.OrgID,
		Name:       r.Name,
		KeyPrefix:  r.KeyPrefix,
		Scopes:     r.Scopes,
		Revoked:    r.Revoked,
		CreatedAt:  r.CreatedAt,
		LastUsedAt: r.LastUsedAt,
		RevokedAt:  r.RevokedAt,
	})
}

// ListKeys — GET /api/v1/orgs/{org_id}/keys
//
// Read access: anyone authenticated in the org. Operators sometimes want to
// see "who created what key" without being able to mutate, so a viewer's view
// is intentionally identical to an owner's. The raw key is never persisted,
// so listing it can never leak the token.
func (s *APIKeysServer) ListKeys(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	urlOrg := chi.URLParam(r, "org_id")
	if urlOrg != claims.OrgID {
		// 404 over 403 — same posture as GetTrace, prevents org enumeration.
		problem.Write(w, http.StatusNotFound, "Not Found", "org not found")
		return
	}

	rows, err := s.Q.ListAPIKeys(r.Context(), claims.OrgID)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "list keys failed")
		return
	}
	views := make([]keyView, 0, len(rows))
	for _, row := range rows {
		views = append(views, rowToView(row))
	}
	writeJSON(w, map[string]any{"keys": views})
}

// CreateKey — POST /api/v1/orgs/{org_id}/keys
// Body: { name?: string }
//
// The raw token is generated server-side, hashed before storage, and returned
// EXACTLY ONCE in the response body. The dashboard surface must show it
// behind a "Copy key" affordance immediately — this is the one moment the
// user can capture it. After this response, no path (DB, API, logs) can
// recover the raw token.
//
// Authorization: owner/admin only. Viewers can list keys but not mint them
// (a viewer minting a key would let them self-elevate to the full API
// surface). principalClass collapses both owner + admin into "owner" for
// this check.
func (s *APIKeysServer) CreateKey(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	urlOrg := chi.URLParam(r, "org_id")
	if urlOrg != claims.OrgID {
		problem.Write(w, http.StatusNotFound, "Not Found", "org not found")
		return
	}
	if claims.PrincipalClass != "owner" {
		problem.Write(w, http.StatusForbidden, "Forbidden", "only owners and admins can create API keys")
		return
	}

	// Defensive size cap — the body is at most a name field + scopes
	// list. 1KB still leaves plenty of headroom and stops a misbehaving
	// client from inflating the JSON decoder buffer.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	var body struct {
		Name   string   `json:"name"`
		Scopes []string `json:"scopes"`
	}
	// Empty body is allowed (name defaults to a server-generated label,
	// scopes default to ingest:write only).
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problem.Write(w, http.StatusBadRequest, "Bad Request", "invalid JSON body")
			return
		}
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		body.Name = "API key " + time.Now().UTC().Format("2006-01-02")
	}
	if len(body.Name) > 80 {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "name must be 80 characters or fewer")
		return
	}

	// Scope validation. Default = ingest:write only — the safest default
	// for a key minted from "Generate key" since the typical caller is an
	// SDK that just needs to write events. Any other scope must be
	// explicitly requested via the body. Unknown scopes are rejected so
	// the user sees an error rather than getting a key with no scopes.
	scopes := body.Scopes
	if len(scopes) == 0 {
		scopes = []string{scopeIngestWrite}
	}
	seen := map[string]bool{}
	deduped := make([]string, 0, len(scopes))
	for _, s := range scopes {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if !validScopes[s] {
			problem.Write(w, http.StatusBadRequest, "Bad Request",
				"unknown scope: "+s+" (allowed: ingest:write, traces:read)")
			return
		}
		if !seen[s] {
			seen[s] = true
			deduped = append(deduped, s)
		}
	}
	if len(deduped) == 0 {
		// Caller sent ["", "  "] etc. Be strict — they meant SOMETHING by
		// passing scopes; falling back silently would be confusing.
		problem.Write(w, http.StatusBadRequest, "Bad Request", "scopes must include at least one valid value")
		return
	}
	scopes = deduped

	// Raw token: 16 random bytes (128 bits of entropy) hex-encoded → 32 chars.
	// Total length sc_live_ + 32 = 40 chars. Indistinguishable shape from
	// Stripe / Anthropic / OpenAI tokens — devs already know what to do with
	// this format.
	var randBytes [16]byte
	if _, err := rand.Read(randBytes[:]); err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "key generation failed")
		return
	}
	rawToken := "sc_live_" + hex.EncodeToString(randBytes[:])
	keyPrefix := rawToken[:12] // "sc_live_" (8) + first 4 hex chars — enough for visual disambiguation.

	h := sha256.Sum256([]byte(rawToken))
	keyHash := hex.EncodeToString(h[:])

	row, err := s.Q.CreateAPIKey(r.Context(), db.CreateAPIKeyParams{
		ID:        uuid.NewString(),
		OrgID:     claims.OrgID,
		KeyHash:   keyHash,
		KeyPrefix: sql.NullString{String: keyPrefix, Valid: true},
		Name:      sql.NullString{String: body.Name, Valid: true},
		Scopes:    scopes,
	})
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "key create failed")
		return
	}

	resp := struct {
		Key      keyView `json:"key"`
		RawToken string  `json:"raw_token"`
	}{
		Key:      createRowToView(row),
		RawToken: rawToken,
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, resp)
}

// RevokeKey — DELETE /api/v1/orgs/{org_id}/keys/{key_id}
//
// Soft delete: flip the `revoked` flag so the row remains for audit but the
// hot-path auth lookup excludes it (the partial index idx_api_keys_active
// has `WHERE revoked = FALSE`).
//
// Postgres update alone would leave the positive Redis cache entry intact
// for up to 60s, which means a revoked key keeps working after the user
// pressed "revoke." We now eagerly DEL `key:<hash>` from Redis the
// moment the row flips. We also set `revoked:<hash>` for 5 minutes — this
// is the same negative-cache convention the Rust ingest already reads via
// `services-rust/ingest/src/auth.rs`, so the SDK path stops accepting the
// key immediately too. After the negative entry expires the underlying
// `revoked=true` row continues to enforce rejection at the Postgres layer.
func (s *APIKeysServer) RevokeKey(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	urlOrg := chi.URLParam(r, "org_id")
	if urlOrg != claims.OrgID {
		problem.Write(w, http.StatusNotFound, "Not Found", "org not found")
		return
	}
	if claims.PrincipalClass != "owner" {
		problem.Write(w, http.StatusForbidden, "Forbidden", "only owners and admins can revoke API keys")
		return
	}
	keyID := chi.URLParam(r, "key_id")
	if keyID == "" {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "missing key_id")
		return
	}

	keyHash, err := s.Q.RevokeAPIKey(r.Context(), db.RevokeAPIKeyParams{
		ID:    keyID,
		OrgID: claims.OrgID,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// `:one` returns ErrNoRows when WHERE matches nothing.
			// Treat all three cases (no row / wrong org / already
			// revoked) as 404 — the user can refresh the list to see why.
			problem.Write(w, http.StatusNotFound, "Not Found", "key not found or already revoked")
			return
		}
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "revoke failed")
		return
	}

	// Best-effort Redis update. A failure here means we fall back to the
	// 60s positive-cache TTL — still safer than the previous code path
	// because the Postgres row is already revoked, just not yet visible
	// to in-cache consumers. We deliberately don't fail the request: the
	// revoke succeeded, the slow-path safety net still works.
	if s.Redis != nil && keyHash != "" {
		go invalidateKeyCache(s.Redis, keyHash)
	}

	w.WriteHeader(http.StatusNoContent)
}

// invalidateKeyCache clears BOTH service-specific positive cache entries
// (the Go API's `key:read:<hash>` and the Rust ingest's `key:ingest:<hash>`)
// and writes a 5-minute negative-cache marker that both services honor. The
// negative TTL is intentionally longer than the positive TTL (60s) so a
// revocation issued during an in-flight cache write race still wins; after
// 5 minutes the Postgres `revoked=true` row alone keeps the key out. The
// negative-cache key (`revoked:<hash>`) is the contract documented in
// services-rust/ingest/src/auth.rs.
func invalidateKeyCache(rdb *redis.Client, keyHash string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	rdb.Del(ctx, "key:read:"+keyHash)        //nolint:errcheck
	rdb.Del(ctx, "key:ingest:"+keyHash)      //nolint:errcheck
	rdb.Set(ctx, "revoked:"+keyHash, "1", 5*time.Minute) //nolint:errcheck
}
