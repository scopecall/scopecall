package middleware

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/scopecall/services-go/common/auth"
	"github.com/scopecall/services-go/api/internal/db"
	"github.com/scopecall/services-go/api/internal/problem"
)

type contextKey int

const claimsKey contextKey = 0

type AuthConfig struct {
	JWKSCache       *auth.JWKSCache
	Redis           *redis.Client
	Queries         *db.Queries
	Log             *zap.Logger
	// InternalAPIKey, when non-empty, enables the trusted-proxy auth path.
	// Set from INTERNAL_API_KEY env var. Used exclusively for Next.js dashboard
	// proxy requests (self-hosted mode). See resolveInternalProxy().
	InternalAPIKey  string
}

// Authenticate validates incoming requests using one of three trust paths:
//
//  1. Trusted-proxy (self-hosted dashboard → Go API):
//     x-internal-key header matches cfg.InternalAPIKey (constant-time compare).
//     x-user-id, x-org-id, x-user-role headers carry identity set by the proxy.
//     ONLY trusted when x-internal-key is valid; rejected otherwise.
//
//  2. API key: Authorization: Bearer sc_live_* or sc_test_*
//     SHA-256 hashed, looked up in Redis cache then Postgres.
//
//  3. JWT: Authorization: Bearer <RS256 token>
//     Validated against JWKS. JTI checked against Redis denylist.
func Authenticate(cfg AuthConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// ── Path 1: trusted proxy (x-internal-key) ───────────────────────
			if cfg.InternalAPIKey != "" {
				if claims, ok := resolveInternalProxy(r, cfg.InternalAPIKey, cfg.Log); ok {
					next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), claimsKey, claims)))
					return
				}
				// If x-internal-key header was present but invalid, reject immediately.
				// Don't fall through — prevents key-confusion attacks.
				if r.Header.Get("x-internal-key") != "" {
					cfg.Log.Warn("invalid x-internal-key", zap.String("remote", r.RemoteAddr))
					problem.Write(w, http.StatusUnauthorized, "Unauthorized", "invalid internal key")
					return
				}
			}

			// ── Paths 2 & 3: Bearer token (API key or JWT) ───────────────────
			token, err := extractBearer(r)
			if err != nil {
				problem.Write(w, http.StatusUnauthorized, "Unauthorized", err.Error())
				return
			}

			var claims *auth.Claims
			if strings.HasPrefix(token, "sc_live_") || strings.HasPrefix(token, "sc_test_") {
				claims, err = resolveAPIKey(r.Context(), token, cfg)
			} else {
				claims, err = resolveJWT(r.Context(), token, cfg)
			}
			if err != nil {
				cfg.Log.Debug("auth failed", zap.Error(err))
				problem.Write(w, http.StatusUnauthorized, "Unauthorized", "invalid or expired credentials")
				return
			}

			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), claimsKey, claims)))
		})
	}
}

// resolveInternalProxy validates the x-internal-key and, if valid, constructs
// Claims from x-user-* headers set by the Next.js proxy.
//
// Security invariants:
//   - Constant-time key comparison prevents timing attacks.
//   - x-user-* headers are NEVER read unless x-internal-key is valid.
//   - External requests that spoof x-user-* without a valid key are rejected.
func resolveInternalProxy(r *http.Request, configuredKey string, log *zap.Logger) (*auth.Claims, bool) {
	provided := r.Header.Get("x-internal-key")
	if provided == "" {
		return nil, false
	}

	// Defense in depth: refuse to authenticate against an empty configured
	// key. The outer call site already gates on `cfg.InternalAPIKey != ""`,
	// and the `provided == ""` check above blocks empty client input — but
	// belt-and-suspenders here makes the property explicit at the actual
	// compare site, so a future refactor that removes the outer gate can't
	// silently turn the proxy into "open mode."
	if configuredKey == "" {
		return nil, false
	}

	// Constant-time comparison — configuredKey is the secret
	if subtle.ConstantTimeCompare([]byte(provided), []byte(configuredKey)) != 1 {
		return nil, false
	}

	// Key is valid — trust the identity headers set by the proxy
	orgID := r.Header.Get("x-org-id")
	userID := r.Header.Get("x-user-id")
	role := r.Header.Get("x-user-role")

	if orgID == "" {
		log.Warn("trusted proxy request missing x-org-id")
		return nil, false
	}
	// Also require x-user-id. The proxy promises identity comes "exclusively
	// from the verified JWT" — that promise needs server-side enforcement so
	// a misconfigured custom OIDC (token missing `id` claim) can't sail
	// through with an empty userID. Empty userID would also match the empty
	// string in saved_views.created_by checks, giving cross-user delete in
	// unintended cases. (S4 from second-pass security review.)
	if userID == "" {
		log.Warn("trusted proxy request missing x-user-id")
		return nil, false
	}

	return &auth.Claims{
		UserID:         userID,
		OrgID:          orgID,
		Role:           role,
		PrincipalClass: principalClass(role),
	}, true
}

func ClaimsFromCtx(ctx context.Context) *auth.Claims {
	c, _ := ctx.Value(claimsKey).(*auth.Claims)
	return c
}

func extractBearer(r *http.Request) (string, error) {
	hdr := r.Header.Get("Authorization")
	if hdr == "" {
		return "", fmt.Errorf("missing Authorization header")
	}
	parts := strings.SplitN(hdr, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", fmt.Errorf("Authorization header must be 'Bearer <token>'")
	}
	tok := strings.TrimSpace(parts[1])
	if tok == "" {
		return "", fmt.Errorf("empty bearer token")
	}
	return tok, nil
}

// readAPIScope is the scope a Bearer-token API key needs in order to
// reach Go API read endpoints (traces / cost / prompts / sessions / …).
// SDK-only keys minted from Settings → API Keys default to ingest:write
// ONLY; they must not authenticate here unless the operator explicitly
// adds traces:read.
const readAPIScope = "traces:read"

func resolveAPIKey(ctx context.Context, token string, cfg AuthConfig) (*auth.Claims, error) {
	h := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(h[:])

	// Negative cache check FIRST. The revoke endpoint writes
	// `revoked:<hash>` with a 5-minute TTL the moment a key flips to
	// revoked=true. Checking this before the positive cache closes the
	// following race:
	//
	//   1. Read request R1 starts, misses the positive cache, queries PG,
	//      key is still valid.
	//   2. Revoke happens, sets `revoked:<hash>`, DELs `key:read:<hash>`.
	//   3. R1 writes `key:read:<hash>` (its post-validation write races
	//      after the DEL).
	//   4. Subsequent read requests would happily hit the now-stale
	//      positive cache and authenticate the revoked key — for up to
	//      60s — if we only checked positive.
	//
	// Symmetric to services-rust/ingest/src/auth.rs which already does
	// this check. Redis errors are non-fatal — we treat them as "no
	// negative marker present" and fall through; the Postgres lookup
	// below is the authoritative gate.
	negKey := "revoked:" + hash
	if revoked, err := cfg.Redis.Exists(ctx, negKey).Result(); err == nil && revoked > 0 {
		return nil, fmt.Errorf("api key revoked")
	}

	// Positive cache check. Entries here are written ONLY after a
	// successful traces:read scope check below, so a hit is enough to
	// trust the key for read access within the TTL.
	//
	// Namespacing matters: the Rust ingest service caches keys at
	// `key:ingest:<hash>` after validating ingest:write. If both services
	// shared a `key:<hash>` namespace, an ingest-only key (which never
	// passes our scope check below) would still authenticate to the read
	// API on every request following the first SDK call. Fixed by
	// splitting the namespaces.
	cacheKey := "key:read:" + hash
	if orgID, err := cfg.Redis.Get(ctx, cacheKey).Result(); err == nil {
		return &auth.Claims{OrgID: orgID, PrincipalClass: "viewer"}, nil
	}

	row, err := cfg.Queries.GetActiveAPIKey(ctx, hash)
	if err != nil {
		return nil, fmt.Errorf("api key not found or revoked")
	}

	// Scope check. NULL scopes (len 0 after sqlc unmarshal) is the
	// legacy back-compat sentinel: keys minted before scopes existed
	// retain full access. Keys with explicit scopes must include
	// traces:read to authenticate against the read API.
	if len(row.Scopes) > 0 && !hasScope(row.Scopes, readAPIScope) {
		return nil, fmt.Errorf("api key lacks %s scope", readAPIScope)
	}

	// Defense in depth: re-check the negative cache after the PG round trip
	// before populating the positive cache. If a revoke landed while we
	// were querying Postgres, the negative marker is now present and we
	// must not cache a positive entry that would survive its DEL. Without
	// this second check the race becomes:
	//
	//   PG_lookup_starts → revoke writes neg + DELs pos → PG_lookup returns
	//   → we Set(pos) AFTER revoke's DEL → revoked key is cached.
	//
	// The second Exists() pushes the window from 60s (positive TTL) down to
	// the gap between the check and the Set — sub-millisecond in practice.
	if revoked, err := cfg.Redis.Exists(ctx, negKey).Result(); err == nil && revoked > 0 {
		return nil, fmt.Errorf("api key revoked")
	}
	cfg.Redis.Set(ctx, cacheKey, row.OrgID, 60*time.Second) //nolint:errcheck

	// Opportunistic last-used bump. The query is self-coalescing — it only
	// writes when the previous stamp is older than 60s — so even under
	// heavy traffic this is at most one UPDATE per key per minute. We
	// don't block auth on the result: a failed bump is a UX paper-cut
	// (stale timestamp in the keys list), not an auth failure.
	go func(id string) {
		// Detach from request context so the bump survives request cancellation.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = cfg.Queries.TouchAPIKeyLastUsed(ctx, id)
	}(row.KeyID)

	return &auth.Claims{OrgID: row.OrgID, PrincipalClass: "viewer"}, nil
}

func hasScope(scopes []string, want string) bool {
	for _, s := range scopes {
		if s == want {
			return true
		}
	}
	return false
}

func resolveJWT(ctx context.Context, token string, cfg AuthConfig) (*auth.Claims, error) {
	claims, err := auth.ValidateJWT(token, cfg.JWKSCache)
	if err != nil {
		return nil, err
	}
	if auth.CheckDenylist(ctx, cfg.Redis, claims.UserID, claims.JTI) {
		return nil, fmt.Errorf("token revoked")
	}
	return claims, nil
}

func principalClass(role string) string {
	switch role {
	case "owner", "admin":
		return "owner"
	default:
		return "viewer"
	}
}
