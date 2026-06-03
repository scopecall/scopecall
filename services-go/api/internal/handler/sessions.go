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

type sessionJSON struct {
	SessionID    string    `json:"session_id"`
	UserID       string    `json:"user_id,omitempty"`
	CallCount    int       `json:"call_count"`
	TotalCostUSD float64   `json:"total_cost_usd"`
	ErrorCount   int       `json:"error_count"`
	FirstAt      time.Time `json:"first_at"`
	LastAt       time.Time `json:"last_at"`
	DurationMS   int64     `json:"duration_ms"`
}

type sessionsResponseJSON struct {
	Sessions []sessionJSON `json:"sessions"`
}

// GetSessionsHTTP serves GET /api/v1/sessions — paginated list of sessions
// (calls grouped by session_id) in the window. Optional ?user_id= scopes to
// one end-user. Powers the Sessions page.
func (s *Server) GetSessionsHTTP(w http.ResponseWriter, r *http.Request) {
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

	userID := q.Get("user_id")
	limit := 0
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	rows, err := query.ListSessions(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, userID, limit)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "sessions query failed")
		return
	}

	resp := sessionsResponseJSON{Sessions: make([]sessionJSON, 0, len(rows))}
	for _, row := range rows {
		resp.Sessions = append(resp.Sessions, sessionJSON{
			SessionID:    row.SessionID,
			UserID:       row.UserID,
			CallCount:    int(row.CallCount),
			TotalCostUSD: row.TotalCostUSD,
			ErrorCount:   int(row.ErrorCount),
			FirstAt:      row.FirstAt,
			LastAt:       row.LastAt,
			DurationMS:   row.LastAt.Sub(row.FirstAt).Milliseconds(),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
