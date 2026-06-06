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

type topMoverJSON struct {
	Key            string  `json:"key"`
	CurrentCostUSD float64 `json:"current_cost_usd"`
	PriorCostUSD   float64 `json:"prior_cost_usd"`
	DeltaCostUSD   float64 `json:"delta_cost_usd"`
	PctChange      float64 `json:"pct_change"` // 0–N, NaN→sentinel below
	// IsNew distinguishes "first-time-seen this window" from "100% drop" or
	// "exactly -1% drop". Old clients can still read pct_change == -1 as
	// before; new clients should check this boolean instead — the float
	// equality check was unreliable and collided with real -1% deltas.
	IsNew        bool    `json:"is_new"`
	CurrentCalls int     `json:"current_calls"`
	PriorCalls   int     `json:"prior_calls"`
	CurrentP99MS float64 `json:"current_p99_ms"`
	PriorP99MS   float64 `json:"prior_p99_ms"`
	DeltaP99MS   float64 `json:"delta_p99_ms"`
}

type topMoversResponseJSON struct {
	GroupBy       string         `json:"group_by"`
	WindowSeconds int            `json:"window_seconds"`
	Rows          []topMoverJSON `json:"rows"`
}

// GetTopMoversHTTP serves GET /api/v1/metrics/top-movers — compares the
// requested window against the prior equal-size window per dimension value,
// sorted by absolute cost delta desc.
func (s *Server) GetTopMoversHTTP(w http.ResponseWriter, r *http.Request) {
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

	groupBy := q.Get("group_by")
	if groupBy == "" {
		groupBy = "model"
	}
	limit := 10
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	rows, err := query.TopMovers(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, groupBy, limit)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "top-movers query failed")
		return
	}

	resp := topMoversResponseJSON{
		GroupBy:       groupBy,
		WindowSeconds: int(to.Sub(from).Seconds()),
		Rows:          make([]topMoverJSON, 0, len(rows)),
	}
	for _, r := range rows {
		// Percent change. The -1 sentinel for "no prior baseline" is retained
		// for backward compatibility with old clients; new clients should use
		// is_new instead — float equality at exactly -1 collides with real
		// -1% deltas.
		//
		// noiseFloor: prior costs below this are treated as effectively
		// zero. A handful of stray events in the prior window (a $0.0003
		// baseline) divided into a real $0.70 current produces a
		// 230,000% "increase" that's mathematically right but useless —
		// the user reads it as "new traffic," not as a faithful
		// percentage. Threshold chosen so legitimate dollar-meaningful
		// baselines (1¢+) still get the real percentage. (User reported
		// the 225,707% noise after seeding fresh data.)
		const noiseFloor = 0.01
		pct := 0.0
		isNew := false
		if r.PriorCostUSD > noiseFloor {
			pct = (r.CurrentCostUSD - r.PriorCostUSD) / r.PriorCostUSD * 100
		} else if r.CurrentCostUSD > 0 {
			pct = -1
			isNew = true
		}
		resp.Rows = append(resp.Rows, topMoverJSON{
			Key:            r.Key,
			CurrentCostUSD: r.CurrentCostUSD,
			PriorCostUSD:   r.PriorCostUSD,
			DeltaCostUSD:   r.DeltaCostUSD,
			PctChange:      pct,
			IsNew:          isNew,
			CurrentCalls:   int(r.CurrentCalls),
			PriorCalls:     int(r.PriorCalls),
			CurrentP99MS:   r.CurrentP99MS,
			PriorP99MS:     r.PriorP99MS,
			DeltaP99MS:     r.DeltaP99MS,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
