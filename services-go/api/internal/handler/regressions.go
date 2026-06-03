package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

// GetRegressionsHTTP serves GET /api/v1/regressions — auto-detected metric
// regressions in the given window vs the equivalent prior window. Powers the
// "Regressions detected" panel on Overview without the user configuring rules.
func (s *Server) GetRegressionsHTTP(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	q := r.URL.Query()
	if q.Get("org_id") != claims.OrgID {
		problem.Write(w, http.StatusForbidden, "Forbidden", "org_id does not match authenticated organization")
		return
	}
	from, errF := time.Parse(time.RFC3339, q.Get("from"))
	to, errT := time.Parse(time.RFC3339, q.Get("to"))
	if errF != nil || errT != nil {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'from' and 'to' must be absolute ISO8601 timestamps")
		return
	}
	if !to.After(from) {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'to' must be after 'from'")
		return
	}
	limit := 0
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	// Prior window = same length, immediately preceding.
	duration := to.Sub(from)
	priorTo := from
	priorFrom := from.Add(-duration)

	rows, err := query.Regressions(
		r.Context(),
		s.CH,
		claims.OrgID,
		query.TimeWindow{From: from, To: to},
		query.TimeWindow{From: priorFrom, To: priorTo},
		limit,
	)
	if err != nil {
		// Don't echo the CH error — leaks query fragments. TODO: structured logging.
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "regressions query failed")
		return
	}

	resp := map[string]any{
		"regressions": rows,
		// Echo back the prior window so the frontend can display "vs the
		// previous N hours" without recomputing client-side.
		"prior_from": priorFrom,
		"prior_to":   priorTo,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
