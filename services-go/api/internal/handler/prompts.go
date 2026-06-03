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

// promptRowJSON is the wire shape for one row of the Prompts page table.
// Hand-defined (this endpoint isn't part of the generated strict server —
// adding to api.gen.go would force a regen with wide blast radius). Keep in
// sync with services-dashboard/src/lib/api/prompts.ts.
type promptRowJSON struct {
	Version         string    `json:"version"`
	Calls           uint64    `json:"calls"`
	TotalCostUSD    float64   `json:"total_cost_usd"`
	AvgCostPerCall  float64   `json:"avg_cost_per_call"`
	P50LatencyMS    float64   `json:"p50_latency_ms"`
	P95LatencyMS    float64   `json:"p95_latency_ms"`
	AvgInputTokens  float64   `json:"avg_input_tokens"`
	AvgOutputTokens float64   `json:"avg_output_tokens"`
	ErrorCount      uint64    `json:"error_count"`
	ErrorRate       float64   `json:"error_rate"`
	FirstSeen       time.Time `json:"first_seen"`
	LastSeen        time.Time `json:"last_seen"`
}

type promptsResponseJSON struct {
	Rows []promptRowJSON `json:"rows"`
}

// GetPromptsHTTP serves GET /api/v1/prompts — aggregated metrics per prompt
// version over a time window. Optional feature_name + environment filters
// scope the aggregation; both are read from URL query params.
func (s *Server) GetPromptsHTTP(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}

	q := r.URL.Query()
	if q.Get("org_id") != claims.OrgID {
		// 403 here (not 404): unlike GetTrace which can leak via 404/403
		// distinction on a specific span, this is an aggregation surface —
		// 403 is the conventional answer for a wrong-org scope query.
		problem.Write(w, http.StatusForbidden, "Forbidden", "org_id does not match authenticated organization")
		return
	}

	from, errFrom := time.Parse(time.RFC3339, q.Get("from"))
	to, errTo := time.Parse(time.RFC3339, q.Get("to"))
	if errFrom != nil || errTo != nil {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'from' and 'to' must be absolute ISO8601 timestamps")
		return
	}
	if !to.After(from) {
		// Same belt-and-suspenders rationale as breakdown.go: middleware
		// also enforces, but keep the handler self-correct.
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'to' must be after 'from'")
		return
	}

	limit := 0
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	rows, err := query.ListPrompts(
		r.Context(), s.CH, claims.OrgID,
		query.TimeWindow{From: from, To: to},
		q.Get("feature_name"),
		q.Get("environment"),
		limit,
	)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "prompts query failed")
		return
	}

	resp := promptsResponseJSON{Rows: make([]promptRowJSON, 0, len(rows))}
	for _, r := range rows {
		resp.Rows = append(resp.Rows, promptRowJSON{
			Version:         r.Version,
			Calls:           r.Calls,
			TotalCostUSD:    r.TotalCostUSD,
			AvgCostPerCall:  r.AvgCostPerCall,
			P50LatencyMS:    r.P50LatencyMS,
			P95LatencyMS:    r.P95LatencyMS,
			AvgInputTokens:  r.AvgInputTokens,
			AvgOutputTokens: r.AvgOutputTokens,
			ErrorCount:      r.ErrorCount,
			ErrorRate:       r.ErrorRate,
			FirstSeen:       r.FirstSeen,
			LastSeen:        r.LastSeen,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
