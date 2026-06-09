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

// breakdownRowJSON / breakdownResponseJSON mirror the BreakdownRow /
// BreakdownResponse schemas in schemas/api/v1.yaml. This endpoint is hand-wired
// (a plain chi handler, not part of the generated strict server), so the JSON
// shape is defined here explicitly and must stay in sync with the spec.
type breakdownRowJSON struct {
	Key            string  `json:"key"`
	Key2           string  `json:"key2,omitempty"` // populated only in cross-dim mode
	Calls          int     `json:"calls"`
	TotalCostUSD   float64 `json:"total_cost_usd"`
	AvgCostPerCall float64 `json:"avg_cost_per_call"`
	ErrorCount     int     `json:"error_count"`
	PctOfTotal     float64 `json:"pct_of_total"`
}

type breakdownResponseJSON struct {
	GroupBy          string             `json:"group_by"`
	SecondaryGroupBy string             `json:"secondary_group_by,omitempty"`
	Rows             []breakdownRowJSON `json:"rows"`
	TotalCostUSD     float64            `json:"total_cost_usd"`
	TotalCalls       int                `json:"total_calls"`
}

var validGroupBy = map[string]bool{
	"model": true, "provider": true, "feature": true, "user": true, "customer": true, "environment": true,
}

// GetBreakdownHTTP serves GET /api/v1/breakdown — cost & call aggregation grouped
// by a dimension. Plain chi handler (see breakdownResponseJSON note above).
func (s *Server) GetBreakdownHTTP(w http.ResponseWriter, r *http.Request) {
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

	from, errFrom := time.Parse(time.RFC3339, q.Get("from"))
	to, errTo := time.Parse(time.RFC3339, q.Get("to"))
	if errFrom != nil || errTo != nil {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'from' and 'to' must be absolute ISO8601 timestamps")
		return
	}
	// Belt-and-suspenders: ValidateTimestamps middleware also rejects
	// to<=from and enforces the 92-day cap. Keeping the handler-level
	// check so this function is correct even if middleware ordering
	// changes in the future. Don't drop without checking main.go's
	// router setup.
	if !to.After(from) {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'to' must be after 'from'")
		return
	}

	groupBy := q.Get("group_by")
	if groupBy == "" {
		groupBy = "model"
	}
	if !validGroupBy[groupBy] {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "invalid group_by; allowed: model, provider, feature, user, customer, environment")
		return
	}

	secondary := q.Get("secondary_group_by")
	if secondary != "" && !validGroupBy[secondary] {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "invalid secondary_group_by; allowed: model, provider, feature, user, customer, environment")
		return
	}
	if secondary != "" && secondary == groupBy {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "secondary_group_by must differ from group_by")
		return
	}

	limit := 0 // query layer applies the default + cap
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	res, err := query.Breakdown(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, groupBy, secondary, limit)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "breakdown query failed")
		return
	}

	resp := breakdownResponseJSON{
		GroupBy:          groupBy,
		SecondaryGroupBy: secondary,
		Rows:             make([]breakdownRowJSON, 0, len(res.Rows)),
		TotalCostUSD:     res.TotalCostUSD,
		TotalCalls:       int(res.TotalCalls),
	}
	for _, row := range res.Rows {
		resp.Rows = append(resp.Rows, breakdownRowJSON{
			Key:            row.Key,
			Key2:           row.Key2,
			Calls:          int(row.Calls),
			TotalCostUSD:   row.TotalCostUSD,
			AvgCostPerCall: row.AvgCostPerCall,
			ErrorCount:     int(row.ErrorCount),
			PctOfTotal:     row.PctOfTotal,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
