package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

type errorBucketJSON struct {
	Timestamp   time.Time `json:"timestamp"`
	Error       int       `json:"error"`
	Timeout     int       `json:"timeout"`
	RateLimited int       `json:"rate_limited"`
}

type errorsByStatusResponseJSON struct {
	Points []errorBucketJSON `json:"points"`
}

// GetErrorsByStatusHTTP serves GET /api/v1/metrics/errors-by-status — hourly
// counts of non-success calls broken into error / timeout / rate_limited.
// Powers the stacked-bar errors chart.
func (s *Server) GetErrorsByStatusHTTP(w http.ResponseWriter, r *http.Request) {
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

	granularity := q.Get("granularity")
	if granularity != "day" {
		granularity = "hour"
	}
	buckets, err := query.ErrorsByStatus(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, granularity)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "errors-by-status query failed")
		return
	}

	resp := errorsByStatusResponseJSON{Points: make([]errorBucketJSON, 0, len(buckets))}
	for _, b := range buckets {
		resp.Points = append(resp.Points, errorBucketJSON{
			Timestamp:   b.Hour,
			Error:       int(b.Error),
			Timeout:     int(b.Timeout),
			RateLimited: int(b.RateLimited),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
