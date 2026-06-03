package middleware

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"

	"github.com/scopecall/services-go/api/internal/problem"
)

// passthroughRecorder writes responses through to the underlying writer and
// also buffers them so a successful response can be written to the cache.
// Used in the non-singleflight path (cache hit / no contention).
type passthroughRecorder struct {
	http.ResponseWriter
	statusCode    int
	body          bytes.Buffer
	headerWritten bool
}

func newRecorder(w http.ResponseWriter) *passthroughRecorder {
	return &passthroughRecorder{ResponseWriter: w, statusCode: http.StatusOK}
}

func (r *passthroughRecorder) WriteHeader(code int) {
	// Match net/http semantics: subsequent WriteHeader calls are no-ops with
	// a log warning. Without this guard, a handler calling Write() then
	// WriteHeader(500) would cache the 200 body against a 500 status —
	// followers receive an error code with a success-shaped body.
	if r.headerWritten {
		return
	}
	r.headerWritten = true
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *passthroughRecorder) Write(b []byte) (int, error) {
	// First Write implicitly calls WriteHeader(200), matching net/http.
	if !r.headerWritten {
		r.headerWritten = true // statusCode already defaults to 200
	}
	r.body.Write(b)
	return r.ResponseWriter.Write(b)
}

// bufferingRecorder ONLY buffers — no pass-through. Used under singleflight,
// where the leader's response needs to be replayed to every waiter that
// joined the in-flight group, including the leader itself (which writes to
// its own ResponseWriter outside the singleflight closure).
type bufferingRecorder struct {
	statusCode int
	body       bytes.Buffer
	headerMap  http.Header
}

func newBufferingRecorder() *bufferingRecorder {
	return &bufferingRecorder{statusCode: http.StatusOK, headerMap: make(http.Header)}
}

func (b *bufferingRecorder) Header() http.Header        { return b.headerMap }
func (b *bufferingRecorder) WriteHeader(code int)       { b.statusCode = code }
func (b *bufferingRecorder) Write(p []byte) (int, error) { return b.body.Write(p) }

// sfResult is what each singleflight call returns. Carries enough info for
// followers to faithfully replay the response on their own ResponseWriter,
// and to set X-Cache: MISS vs BYPASS so ops can distinguish cacheable misses
// from "we executed but couldn't cache" cases (cancellation, malformed JSON).
type sfResult struct {
	body       []byte
	statusCode int
	headers    http.Header
	cacheable  bool
}

// cacheGroup deduplicates concurrent cache misses for the same key.
// Without singleflight, when a hot cache entry's TTL expires, N concurrent
// dashboard requests all miss and all execute the underlying handler in
// parallel — multiplying ClickHouse query load N× for nothing. With it,
// the first request executes; the others wait for the same result.
//
// Package-level group: shared across endpoints because cache keys are
// already endpoint-scoped (see buildCacheKey). No cross-endpoint
// interference.
var cacheGroup singleflight.Group

// Cache wraps a handler with read-through Redis caching + singleflight
// stampede protection.
//
// Cache key: cache:v2:{endpoint}:{org_id}:{principal_class}:{path+params_hash}
func Cache(rdb *redis.Client, ttl time.Duration, endpoint string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Bypass header: owner only
			if r.Header.Get("X-ScopeCall-No-Cache") == "1" {
				claims := ClaimsFromCtx(r.Context())
				if claims == nil || claims.PrincipalClass != "owner" {
					problem.Write(w, http.StatusForbidden, "forbidden", "cache bypass requires owner role")
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			key, err := buildCacheKey(r, endpoint)
			if err != nil {
				// buildCacheKey only fails when auth claims are absent — which
				// shouldn't happen because Authenticate ran first. Pass through
				// defensively.
				next.ServeHTTP(w, r)
				return
			}

			// 1. Fast path: cache HIT serves directly, no singleflight overhead.
			if cached, err := rdb.Get(r.Context(), key).Bytes(); err == nil {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("X-Cache", "HIT")
				w.Write(cached) //nolint:errcheck
				return
			}

			// 2. MISS path: join (or start) a singleflight group keyed on the
			// cache key. Only the leader executes the handler; followers wait.
			result, _, _ := cacheGroup.Do(key, func() (any, error) {
				// Inside the leader: re-check cache. Another goroutine in a
				// different process (or one that completed between our GET
				// and the Do entry) might have populated it already.
				if cached, err := rdb.Get(r.Context(), key).Bytes(); err == nil {
					return &sfResult{
						body:       cached,
						statusCode: http.StatusOK,
						headers:    http.Header{"Content-Type": []string{"application/json"}},
						cacheable:  true,
					}, nil
				}
				// Execute the wrapped handler into an off-screen buffer.
				rec := newBufferingRecorder()
				next.ServeHTTP(rec, r)

				// CRITICAL: do NOT cache when:
				//   (a) the leader's context was cancelled mid-execution
				//   (b) the buffered body isn't a complete JSON document
				//   (c) status code != 200
				//
				// AND when uncacheable, forget the singleflight entry so
				// followers don't receive the leader's truncated buffer.
				// This is the v2 fix: the third-pass change stopped poisoning
				// Redis, but followers still got the bad bytes. Now we
				// Forget() the key, signal cacheable=false, and let each
				// follower re-execute the handler against its OWN context.
				// (S-2 from fourth-pass review.)
				body := rec.body.Bytes()
				cacheable := rec.statusCode == http.StatusOK &&
					r.Context().Err() == nil &&
					len(body) > 0 &&
					json.Valid(body)
				if cacheable {
					// Use Background context so a follower-cancel race can't
					// kill the SET. The leader has already produced a valid
					// response; cache it even if THIS request is torn down.
					rdb.Set(context.Background(), key, body, ttl) //nolint:errcheck
				} else {
					// Forget the in-flight entry. New requests for this key
					// re-enter Do() and execute fresh — they don't piggyback
					// on the leader's failed result.
					cacheGroup.Forget(key)
				}
				return &sfResult{
					body:       body,
					statusCode: rec.statusCode,
					headers:    rec.headerMap,
					cacheable:  cacheable,
				}, nil
			})

			sf := result.(*sfResult)
			// If the leader's result isn't cacheable AND we're not the
			// leader, re-execute against our own context. Detection: if the
			// result body fails JSON validation OR we got a non-200 from a
			// "cacheable" path (which shouldn't happen, defensively), bail
			// to direct execution. This is the load-bearing follower fix:
			// followers no longer inherit the leader's cancellation.
			if !sf.cacheable {
				// Re-execute directly on this request's ResponseWriter.
				// One extra ClickHouse query per follower-in-this-wave is
				// strictly better than every follower getting a broken JSON
				// response that downstream code interprets as a backend bug.
				next.ServeHTTP(w, r)
				return
			}

			// Cacheable path: replay the response on this request's writer.
			for k, vv := range sf.headers {
				for _, v := range vv {
					w.Header().Add(k, v)
				}
			}
			if w.Header().Get("Content-Type") == "" {
				w.Header().Set("Content-Type", "application/json")
			}
			w.Header().Set("X-Cache", "MISS")
			if sf.statusCode != http.StatusOK {
				w.WriteHeader(sf.statusCode)
			}
			w.Write(sf.body) //nolint:errcheck
		})
	}
}

// canonicalizeParams produces a stable string for cache key hashing.
// Algorithm (must not change without a cache version bump — increment v1 → v2):
//  1. Sort query params alphabetically by key.
//  2. Trim leading/trailing whitespace from all values.
//  3. Skip empty values.
//  4. Skip cache-control headers (X-ScopeCall-No-Cache is a header, not a param).
//
// Timestamp validation (absolute ISO8601 required) is done in the handler layer,
// not here — invalid timestamps produce a 400 before reaching cache logic.
func canonicalizeParams(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var parts []string
	for _, k := range keys {
		for _, v := range q[k] {
			v = strings.TrimSpace(v)
			if v != "" {
				parts = append(parts, k+"="+v)
			}
		}
	}
	return strings.Join(parts, "&")
}

func buildCacheKey(r *http.Request, endpoint string) (string, error) {
	claims := ClaimsFromCtx(r.Context())
	if claims == nil {
		return "", fmt.Errorf("no claims in context")
	}
	params := canonicalizeParams(r.URL.Query())
	// Include the request path so resources distinguished only by a path
	// parameter — e.g. /traces/{span_id}, where span_id is NOT a query param —
	// don't collide on the same cache key. Without this, every trace-detail
	// request for a given org+principal hashes identically (org_id is the only
	// query param) and returns the first cached trace for the whole TTL.
	h := sha256.Sum256([]byte(r.URL.Path + "?" + params))
	return fmt.Sprintf("cache:v2:%s:%s:%s:%x",
		endpoint, claims.OrgID, claims.PrincipalClass, h[:8]), nil
}
