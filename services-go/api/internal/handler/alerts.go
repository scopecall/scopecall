package handler

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/go-chi/chi/v5"

	"github.com/scopecall/services-go/api/internal/alerts"
	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

// AlertsServer exposes the rules CRUD + events list. Holds both the Postgres
// store (for rules/events) and a ClickHouse handle (for the alert→trace
// drill-down, which needs to query llm_calls in the rule's evaluation window).
type AlertsServer struct {
	Store *alerts.Store
	CH    driver.Conn
}

// ListRules — GET /api/v1/alerts/rules
func (s *AlertsServer) ListRules(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	rules, err := s.Store.ListRules(r.Context(), claims.OrgID)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "list rules failed")
		return
	}
	writeJSON(w, map[string]any{"rules": rules})
}

// CreateRule — POST /api/v1/alerts/rules
func (s *AlertsServer) CreateRule(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	// Owner-only for now — creating an alert is a mutating action that can
	// notify external systems. Viewer accidentally Slacking a customer is bad.
	if claims.PrincipalClass != "owner" {
		problem.Write(w, http.StatusForbidden, "Forbidden", "owner role required to create alert rules")
		return
	}
	// Bound peak decoder memory. MaxBytesReader caps TOTAL request bytes —
	// slow-body attacks are killed by the chi server-level 30s timeout, not
	// this cap. Both matter: timeout prevents resource exhaustion, cap
	// prevents large single requests from filling the decode buffer.
	// 64KB is generous for an alert rule (a real rule is under 1KB).
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var body alerts.Rule
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "invalid JSON")
		return
	}
	body.OrgID = claims.OrgID

	created, err := s.Store.CreateRule(r.Context(), &body)
	if err != nil {
		// Only surface validation errors verbatim — those are user input
		// problems the SDK/UI author needs to fix. Anything else (Postgres
		// errors, internal failures) gets a generic message so we don't
		// leak schema/FK details. errors.Is replaces the brittle prefix
		// match we previously used.
		if errors.Is(err, alerts.ErrRuleNameRequired) ||
			errors.Is(err, alerts.ErrInvalidRuleType) ||
			errors.Is(err, alerts.ErrInvalidChannelType) ||
			errors.Is(err, alerts.ErrWindowSecondsRange) ||
			errors.Is(err, alerts.ErrThresholdInvalid) {
			problem.Write(w, http.StatusBadRequest, "Bad Request", err.Error())
			return
		}
		problem.Write(w, http.StatusBadRequest, "Bad Request",
			"alert rule creation failed (check name, type, threshold, channel_config)")
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, created)
}

// PatchRule — PATCH /api/v1/alerts/rules/{id}   body: {"enabled": bool}
func (s *AlertsServer) PatchRule(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	if claims.PrincipalClass != "owner" {
		problem.Write(w, http.StatusForbidden, "Forbidden", "owner role required")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "rule id required")
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10) // PATCH body is tiny — 4KB cap
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Enabled == nil {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "body must be {\"enabled\": bool}")
		return
	}
	if err := s.Store.SetEnabled(r.Context(), claims.OrgID, id, *body.Enabled); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			problem.Write(w, http.StatusNotFound, "Not Found", "rule not found")
			return
		}
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "update failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeleteRule — DELETE /api/v1/alerts/rules/{id}
func (s *AlertsServer) DeleteRule(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	if claims.PrincipalClass != "owner" {
		problem.Write(w, http.StatusForbidden, "Forbidden", "owner role required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := s.Store.DeleteRule(r.Context(), claims.OrgID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			problem.Write(w, http.StatusNotFound, "Not Found", "rule not found")
			return
		}
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListEvents — GET /api/v1/alerts/events?limit=...
// Replaces the old stub /api/v1/alerts. Returns real fired/resolved events.
func (s *AlertsServer) ListEvents(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	events, err := s.Store.ListEvents(r.Context(), claims.OrgID, limit)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "list events failed")
		return
	}
	writeJSON(w, map[string]any{"events": events})
}

// EventTraces — GET /api/v1/alerts/events/{id}/traces
//
// Returns the top sample traces that contributed to the alert event firing.
// This is the connective tissue between "an alert fired" and "here's what to
// debug" — closes the loop the user complained about.
func (s *AlertsServer) EventTraces(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	eventID := chi.URLParam(r, "id")
	if eventID == "" {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "missing event id")
		return
	}

	ewr, err := s.Store.GetEventWithRule(r.Context(), claims.OrgID, eventID)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "fetch event failed")
		return
	}
	if ewr == nil {
		problem.Write(w, http.StatusNotFound, "Not Found", "event not found")
		return
	}

	limit := 5
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	traces, err := query.SampleTracesForAlert(
		r.Context(),
		s.CH,
		claims.OrgID,
		string(ewr.Rule.Type),
		ewr.Rule.DimFilter,
		ewr.Event.FiredAt,
		ewr.Rule.WindowSeconds,
		limit,
	)
	if err != nil {
		// Don't echo the underlying CH error — leaks column names, query
		// fragments, sometimes data values. TODO: structured logging here.
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "sample traces query failed")
		return
	}

	writeJSON(w, map[string]any{
		"traces": traces,
		// Echo back the window so the frontend can label "looking in the 5
		// minutes before fire time" without a second roundtrip.
		"window_from":    ewr.Event.FiredAt.Add(-time.Duration(ewr.Rule.WindowSeconds) * time.Second),
		"window_to":      ewr.Event.FiredAt,
		"window_seconds": ewr.Rule.WindowSeconds,
		"rule_type":      ewr.Rule.Type,
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
