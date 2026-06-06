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

type workflowCostNodeJSON struct {
	Name           string  `json:"name"`
	CurrentCostUSD float64 `json:"current_cost_usd"`
	PriorCostUSD   float64 `json:"prior_cost_usd"`
	DeltaCostUSD   float64 `json:"delta_cost_usd"`
	// PctChange uses the same -1 sentinel as TopMovers for "no prior baseline".
	// New clients should check IsNew instead — float equality at -1 collides
	// with a real -1% drop.
	PctChange     float64 `json:"pct_change"`
	IsNew         bool    `json:"is_new"`
	CurrentCalls  int     `json:"current_calls"`
	ErrorCount    int     `json:"error_count"`
	CustomerCount int     `json:"customer_count"`
	IsTestShare   float64 `json:"is_test_share"`
}

type workflowCostTreeResponseJSON struct {
	WindowSeconds int                    `json:"window_seconds"`
	TotalCostUSD  float64                `json:"total_cost_usd"`
	Workflows     []workflowCostNodeJSON `json:"workflows"`
}

// GetWorkflowCostTreeHTTP serves GET /api/v1/workflow-cost-tree — workflow
// rollups for the Overview treemap.
//
// Each row is a workflow's total LLM cost in the requested window, plus the
// equivalent prior-window cost for delta/color computation on the frontend.
// Attribution is by trace_id self-join — see WorkflowCostTree() doc.
func (s *Server) GetWorkflowCostTreeHTTP(w http.ResponseWriter, r *http.Request) {
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

	limit := 20
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	rows, err := query.WorkflowCostTree(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, limit)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "workflow-cost-tree query failed")
		return
	}

	resp := workflowCostTreeResponseJSON{
		WindowSeconds: int(to.Sub(from).Seconds()),
		Workflows:     make([]workflowCostNodeJSON, 0, len(rows)),
	}
	// Same noise-floor reasoning as TopMovers: a $0.0003 prior baseline divided
	// into a $0.70 current is mathematically a 230,000% jump but useless to
	// the user — they need to read it as "new traffic," not as a percentage.
	const noiseFloor = 0.01
	for _, n := range rows {
		delta := n.CurrentCostUSD - n.PriorCostUSD
		pct := 0.0
		isNew := false
		if n.PriorCostUSD > noiseFloor {
			pct = (n.CurrentCostUSD - n.PriorCostUSD) / n.PriorCostUSD * 100
		} else if n.CurrentCostUSD > 0 {
			pct = -1
			isNew = true
		}
		resp.TotalCostUSD += n.CurrentCostUSD
		resp.Workflows = append(resp.Workflows, workflowCostNodeJSON{
			Name:           n.Name,
			CurrentCostUSD: n.CurrentCostUSD,
			PriorCostUSD:   n.PriorCostUSD,
			DeltaCostUSD:   delta,
			PctChange:      pct,
			IsNew:          isNew,
			CurrentCalls:   int(n.CurrentCalls),
			ErrorCount:     int(n.ErrorCount),
			CustomerCount:  int(n.CustomerCount),
			IsTestShare:    n.IsTestShare,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
