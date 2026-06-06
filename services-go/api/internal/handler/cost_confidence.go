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

type costSourceShareJSON struct {
	Source    string  `json:"source"`
	Calls     int     `json:"calls"`
	CostUSD   float64 `json:"cost_usd"`
	PctOfCost float64 `json:"pct_of_cost"`
}

type unknownModelJSON struct {
	Model    string  `json:"model"`
	Provider string  `json:"provider"`
	Calls    int     `json:"calls"`
	CostUSD  float64 `json:"cost_usd"`
}

type costConfidenceResponseJSON struct {
	WindowSeconds     int     `json:"window_seconds"`
	TotalCostUSD      float64 `json:"total_cost_usd"`
	ServerComputedUSD float64 `json:"server_computed_cost_usd"`
	// VerifiedPct = server_computed / total — the single headline number.
	// 100.0 when total=0 (degenerate empty window — nothing to be wrong about).
	VerifiedPct   float64               `json:"verified_pct"`
	Sources       []costSourceShareJSON `json:"sources"`
	UnknownModels []unknownModelJSON    `json:"unknown_models"`
}

// GetCostConfidenceHTTP serves GET /api/v1/cost-confidence — the
// trust-in-the-dollar-number indicator. Tells the user what share of their
// reported cost came from server-priced rows (trustworthy) vs SDK fallback
// or unknown-model fallback (unverifiable), plus a punch list of unknown
// models to add to the pricing table.
func (s *Server) GetCostConfidenceHTTP(w http.ResponseWriter, r *http.Request) {
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

	unknownLimit := 10
	if v := q.Get("unknown_limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			unknownLimit = n
		}
	}

	res, err := query.CostConfidence(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, unknownLimit)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "cost-confidence query failed")
		return
	}

	verified := 100.0
	if res.TotalCostUSD > 0 {
		verified = res.ServerComputedUSD / res.TotalCostUSD * 100
	}

	resp := costConfidenceResponseJSON{
		WindowSeconds:     int(to.Sub(from).Seconds()),
		TotalCostUSD:      res.TotalCostUSD,
		ServerComputedUSD: res.ServerComputedUSD,
		VerifiedPct:       verified,
		Sources:           make([]costSourceShareJSON, 0, len(res.Sources)),
		UnknownModels:     make([]unknownModelJSON, 0, len(res.UnknownModels)),
	}
	for _, s := range res.Sources {
		share := 0.0
		if res.TotalCostUSD > 0 {
			share = s.CostUSD / res.TotalCostUSD * 100
		}
		resp.Sources = append(resp.Sources, costSourceShareJSON{
			Source:    s.Source,
			Calls:     int(s.Calls),
			CostUSD:   s.CostUSD,
			PctOfCost: share,
		})
	}
	for _, u := range res.UnknownModels {
		resp.UnknownModels = append(resp.UnknownModels, unknownModelJSON{
			Model:    u.Model,
			Provider: u.Provider,
			Calls:    int(u.Calls),
			CostUSD:  u.CostUSD,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
