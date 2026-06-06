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

type customerProfitabilityRowJSON struct {
	CustomerID       string  `json:"customer_id"`
	CurrentCostUSD   float64 `json:"current_cost_usd"`
	PriorCostUSD     float64 `json:"prior_cost_usd"`
	DeltaCostUSD     float64 `json:"delta_cost_usd"`
	PctChange        float64 `json:"pct_change"`
	IsNew            bool    `json:"is_new"`
	CurrentCalls     int     `json:"current_calls"`
	ErrorCount       int     `json:"error_count"`
	WorkflowCount    int     `json:"workflow_count"`
	ModelCount       int     `json:"model_count"`
	RetryCostUSD     float64 `json:"retry_cost_usd"`
	TestCostUSD      float64 `json:"test_cost_usd"`
	CacheReadSavings float64 `json:"cache_read_savings_usd"`
	// PctOfAttributed is this customer's share of attributed cost (0..100).
	// Computed against attributed (not grand-total) so the row percentages
	// add to 100% even when the org has Unattributed spend.
	PctOfAttributed float64 `json:"pct_of_attributed"`
}

type customerProfitabilityResponseJSON struct {
	WindowSeconds           int                            `json:"window_seconds"`
	GrandTotalCostUSD       float64                        `json:"grand_total_cost_usd"`
	AttributedCostUSD       float64                        `json:"attributed_cost_usd"`
	UnattributedCostUSD     float64                        `json:"unattributed_cost_usd"`
	AttributedCustomerCount int                            `json:"attributed_customer_count"`
	Rows                    []customerProfitabilityRowJSON `json:"rows"`
}

// GetCustomerProfitabilityHTTP serves GET /api/v1/customer-profitability —
// the B2B "is this customer profitable?" rollup. Sorted by current-window
// cost descending; includes prior-period for delta, plus retry / test /
// cache signals so the frontend can flag wasteful spend per customer.
func (s *Server) GetCustomerProfitabilityHTTP(w http.ResponseWriter, r *http.Request) {
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

	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	rows, err := query.CustomerProfitability(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, limit)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "customer-profitability query failed")
		return
	}
	totals, err := query.CustomerProfitabilityTotalsQuery(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to})
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "customer-profitability totals query failed")
		return
	}

	const noiseFloor = 0.01
	resp := customerProfitabilityResponseJSON{
		WindowSeconds:           int(to.Sub(from).Seconds()),
		GrandTotalCostUSD:       totals.GrandTotalCostUSD,
		AttributedCostUSD:       totals.AttributedCostUSD,
		UnattributedCostUSD:     totals.UnattributedCostUSD,
		AttributedCustomerCount: int(totals.AttributedCustomerCount),
		Rows:                    make([]customerProfitabilityRowJSON, 0, len(rows)),
	}
	for _, r := range rows {
		delta := r.CurrentCostUSD - r.PriorCostUSD
		pct := 0.0
		isNew := false
		if r.PriorCostUSD > noiseFloor {
			pct = (r.CurrentCostUSD - r.PriorCostUSD) / r.PriorCostUSD * 100
		} else if r.CurrentCostUSD > 0 {
			pct = -1
			isNew = true
		}
		share := 0.0
		if totals.AttributedCostUSD > 0 {
			share = r.CurrentCostUSD / totals.AttributedCostUSD * 100
		}
		resp.Rows = append(resp.Rows, customerProfitabilityRowJSON{
			CustomerID:       r.CustomerID,
			CurrentCostUSD:   r.CurrentCostUSD,
			PriorCostUSD:     r.PriorCostUSD,
			DeltaCostUSD:     delta,
			PctChange:        pct,
			IsNew:            isNew,
			CurrentCalls:     int(r.CurrentCalls),
			ErrorCount:       int(r.ErrorCount),
			WorkflowCount:    int(r.WorkflowCount),
			ModelCount:       int(r.ModelCount),
			RetryCostUSD:     r.RetryCostUSD,
			TestCostUSD:      r.TestCostUSD,
			CacheReadSavings: r.CacheReadSavings,
			PctOfAttributed:  share,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
