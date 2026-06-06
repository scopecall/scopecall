package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

type workflowBreakdownRowJSON struct {
	Key        string  `json:"key"`
	CostUSD    float64 `json:"cost_usd"`
	Calls      int     `json:"calls"`
	ErrorCount int     `json:"error_count"`
}

type workflowSummaryJSON struct {
	TotalCostUSD     float64 `json:"total_cost_usd"`
	PriorCostUSD     float64 `json:"prior_cost_usd"`
	DeltaCostUSD     float64 `json:"delta_cost_usd"`
	PctChange        float64 `json:"pct_change"`
	IsNew            bool    `json:"is_new"`
	TotalCalls       int     `json:"total_calls"`
	ErrorCount       int     `json:"error_count"`
	CustomerCount    int     `json:"customer_count"`
	RetryCostUSD     float64 `json:"retry_cost_usd"`
	TestCostUSD      float64 `json:"test_cost_usd"`
	CacheReadSavings float64 `json:"cache_read_savings_usd"`
}

type workflowDetailResponseJSON struct {
	Workflow      string                     `json:"workflow"`
	WindowSeconds int                        `json:"window_seconds"`
	Summary       workflowSummaryJSON        `json:"summary"`
	ByAgent       []workflowBreakdownRowJSON `json:"by_agent"`
	ByStep        []workflowBreakdownRowJSON `json:"by_step"`
	ByCustomer    []workflowBreakdownRowJSON `json:"by_customer"`
	ByModel       []workflowBreakdownRowJSON `json:"by_model"`
	CostSourceMix []workflowBreakdownRowJSON `json:"cost_source_mix"`
}

// GetWorkflowDetailHTTP serves GET /api/v1/workflow-detail — one-shot rollup
// for the workflow drill-down page. Loads summary + 5 breakdowns
// (agent / step / customer / model / cost_source) in a single API call so
// the page renders without staggered loading states.
func (s *Server) GetWorkflowDetailHTTP(w http.ResponseWriter, r *http.Request) {
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

	workflow := q.Get("workflow")
	if workflow == "" {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'workflow' is required")
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

	res, err := query.WorkflowDetail(r.Context(), s.CH, claims.OrgID, workflow, query.TimeWindow{From: from, To: to})
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "workflow-detail query failed")
		return
	}

	// Compute delta + pct_change with the same noise-floor / is_new convention
	// as TopMovers and WorkflowCostTree — see those handlers for the rationale.
	const noiseFloor = 0.01
	delta := res.Summary.TotalCostUSD - res.Summary.PriorCostUSD
	pct := 0.0
	isNew := false
	if res.Summary.PriorCostUSD > noiseFloor {
		pct = (res.Summary.TotalCostUSD - res.Summary.PriorCostUSD) / res.Summary.PriorCostUSD * 100
	} else if res.Summary.TotalCostUSD > 0 {
		pct = -1
		isNew = true
	}

	resp := workflowDetailResponseJSON{
		Workflow:      workflow,
		WindowSeconds: int(to.Sub(from).Seconds()),
		Summary: workflowSummaryJSON{
			TotalCostUSD:     res.Summary.TotalCostUSD,
			PriorCostUSD:     res.Summary.PriorCostUSD,
			DeltaCostUSD:     delta,
			PctChange:        pct,
			IsNew:            isNew,
			TotalCalls:       int(res.Summary.TotalCalls),
			ErrorCount:       int(res.Summary.ErrorCount),
			CustomerCount:    int(res.Summary.CustomerCount),
			RetryCostUSD:     res.Summary.RetryCostUSD,
			TestCostUSD:      res.Summary.TestCostUSD,
			CacheReadSavings: res.Summary.CacheReadSavings,
		},
		ByAgent:       toBreakdownJSON(res.ByAgent),
		ByStep:        toBreakdownJSON(res.ByStep),
		ByCustomer:    toBreakdownJSON(res.ByCustomer),
		ByModel:       toBreakdownJSON(res.ByModel),
		CostSourceMix: toBreakdownJSON(res.CostSourceMix),
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func toBreakdownJSON(rows []query.WorkflowBreakdownRow) []workflowBreakdownRowJSON {
	out := make([]workflowBreakdownRowJSON, 0, len(rows))
	for _, r := range rows {
		out = append(out, workflowBreakdownRowJSON{
			Key:        r.Key,
			CostUSD:    r.CostUSD,
			Calls:      int(r.Calls),
			ErrorCount: int(r.ErrorCount),
		})
	}
	return out
}
