package middleware

import (
	"fmt"
	"net/http"
	"time"

	"github.com/scopecall/services-go/api/internal/problem"
)

// MaxQueryWindow caps how large a (to - from) range we accept. ClickHouse
// raw-scan endpoints (traces list, breakdown cross-dim, sessions, top-movers,
// regressions, graph, trace-tree) would otherwise scan whatever TTL we have
// configured on every request — `?from=2020&to=2100` is currently accepted.
// 92 days = a generous 3 months, wider than the typical user need but well
// under cluster TTL.
const MaxQueryWindow = 92 * 24 * time.Hour

// ValidateTimestamps rejects requests where ?from= or ?to= params are present
// but not parseable as absolute RFC3339 timestamps, OR span an unreasonably
// large window (DoS protection — see MaxQueryWindow).
//
// Relative values like "now-24h" parse to zero-time and would silently hit year 0001;
// this middleware catches them before they reach the cache key or handler.
//
// Only validates params that are present — endpoints without timestamp params
// (e.g. /alerts) pass through unaffected.
func ValidateTimestamps(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		var fromT, toT time.Time
		var fromOK, toOK bool
		var err error

		if from := q.Get("from"); from != "" {
			fromT, err = time.Parse(time.RFC3339, from)
			if err != nil {
				problem.Write(w, http.StatusBadRequest, "Bad Request",
					fmt.Sprintf("parameter 'from' must be an absolute ISO8601 timestamp (e.g. 2026-05-01T00:00:00Z), got: %q", from))
				return
			}
			fromOK = true
		}

		if to := q.Get("to"); to != "" {
			toT, err = time.Parse(time.RFC3339, to)
			if err != nil {
				problem.Write(w, http.StatusBadRequest, "Bad Request",
					fmt.Sprintf("parameter 'to' must be an absolute ISO8601 timestamp (e.g. 2026-05-22T00:00:00Z), got: %q", to))
				return
			}
			toOK = true
		}

		// Window validation: reject huge windows AND reversed windows (to<from).
		// Reversed windows pass the cap check (negative duration < MaxQueryWindow)
		// but produce nonsense at the handler — prior-period delta calculations
		// of negative duration, etc. Catch centrally rather than relying on
		// every handler's per-endpoint `!to.After(from)` guard. (T-1 from review.)
		if fromOK && toOK {
			delta := toT.Sub(fromT)
			if delta <= 0 {
				problem.Write(w, http.StatusBadRequest, "Bad Request",
					"'to' must be strictly after 'from'")
				return
			}
			if delta > MaxQueryWindow {
				problem.Write(w, http.StatusBadRequest, "Bad Request",
					fmt.Sprintf("query window too large: %s requested, max %s. Tighten the range or use a rollup endpoint.", delta.Round(time.Hour), MaxQueryWindow))
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}
