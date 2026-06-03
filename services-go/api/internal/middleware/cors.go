package middleware

import (
	"net/http"
	"regexp"
	"strings"
)

// CORS returns a middleware that sets CORS headers.
// origins: exact-match allow list (e.g. "https://app.scopecall.ai").
// originRegex: optional compiled regex for dynamic origins (Vercel preview deploys).
//
// Usage (main.go):
//
//	origins := strings.Split(envOr("CORS_ORIGINS", "http://localhost:3000"), ",")
//	re      := compileCORSRegex(envOr("CORS_ORIGIN_REGEX", ""))
//	r.Use(apimw.CORS(origins, re))
//
// In production (APP_ENV=production), localhost is not in the allow list unless
// explicitly included in CORS_ORIGINS.
func CORS(origins []string, originRegex *regexp.Regexp) func(http.Handler) http.Handler {
	// Build a set for O(1) exact lookup
	allowed := make(map[string]struct{}, len(origins))
	for _, o := range origins {
		o = strings.TrimSpace(o)
		if o != "" {
			allowed[o] = struct{}{}
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && isAllowed(origin, allowed, originRegex) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers",
					"Authorization, Content-Type, X-ScopeCall-No-Cache, X-Request-ID")
				w.Header().Set("Access-Control-Allow-Credentials", "false")
				w.Header().Set("Access-Control-Max-Age", "86400")
				w.Header().Set("Vary", "Origin")
			}

			// Short-circuit preflight
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// CompileCORSRegex compiles the CORS_ORIGIN_REGEX env var.
// Returns nil if empty (no regex matching).
//
// SAFETY: regexp.MatchString is substring-match. An unanchored pattern like
// `scopecall\.app` would happily match `evil-scopecall.app.attacker.com`. We
// force-anchor with `^(?:...)$` so operators can't ship an exploitable config
// by forgetting the anchors. If the caller already anchored their pattern,
// the redundant outer anchors are harmless.
func CompileCORSRegex(pattern string) *regexp.Regexp {
	if pattern == "" {
		return nil
	}
	anchored := "^(?:" + pattern + ")$"
	re, err := regexp.Compile(anchored)
	if err != nil {
		// Bad regex in env — log and disable regex matching rather than panic.
		return nil
	}
	return re
}

func isAllowed(origin string, exact map[string]struct{}, re *regexp.Regexp) bool {
	if _, ok := exact[origin]; ok {
		return true
	}
	if re != nil && re.MatchString(origin) {
		return true
	}
	return false
}
