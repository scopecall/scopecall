package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

type wasteItemJSON struct {
	Kind                string  `json:"kind"`     // retry_burner | model_misuse | high_error_workflow
	Severity            string  `json:"severity"` // high | medium | low
	Headline            string  `json:"headline"`
	Detail              string  `json:"detail"`
	Recommendation      string  `json:"recommendation"`
	PotentialSavingsUSD float64 `json:"potential_savings_usd"`
	Workflow            string  `json:"workflow,omitempty"`
	Model               string  `json:"model,omitempty"`
	Step                string  `json:"step,omitempty"`
}

type wasteInboxResponseJSON struct {
	WindowSeconds       int             `json:"window_seconds"`
	TotalSavingsUSD     float64         `json:"total_savings_usd"`
	Items               []wasteItemJSON `json:"items"`
}

// GetWasteInboxHTTP serves GET /api/v1/waste-inbox — deterministic-rule
// findings of wasted spend in the window. Surfaced on Overview as a list
// of actionable items ranked by dollar impact descending.
func (s *Server) GetWasteInboxHTTP(w http.ResponseWriter, r *http.Request) {
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

	items, err := query.WasteInbox(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to})
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "waste-inbox query failed")
		return
	}

	resp := wasteInboxResponseJSON{
		WindowSeconds: int(to.Sub(from).Seconds()),
		Items:         make([]wasteItemJSON, 0, len(items)),
	}
	for _, it := range items {
		resp.TotalSavingsUSD += it.PotentialSavingsUSD
		resp.Items = append(resp.Items, wasteItemJSON{
			Kind:                it.Kind,
			Severity:            it.Severity,
			Headline:            it.Headline,
			Detail:              it.Detail,
			Recommendation:      it.Recommendation,
			PotentialSavingsUSD: it.PotentialSavingsUSD,
			Workflow:            it.Workflow,
			Model:               it.Model,
			Step:                it.Step,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
