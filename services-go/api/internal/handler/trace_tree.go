package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

// traceSpanJSON mirrors the Trace schema in schemas/api/v1.yaml. This endpoint
// is hand-wired (not part of the generated strict server — same reason as
// /breakdown: regenerating api.gen.go restructures every endpoint's error
// responses). Pointer fields express the nullable spec properties.
type traceSpanJSON struct {
	OrgID        string     `json:"org_id"`
	TraceID      string     `json:"trace_id"`
	SpanID       string     `json:"span_id"`
	ParentSpanID *string    `json:"parent_span_id,omitempty"`
	Timestamp    time.Time  `json:"timestamp"`
	Model        string     `json:"model"`
	Provider     string     `json:"provider"`
	InputTokens   uint32     `json:"input_tokens"`
	OutputTokens  uint32     `json:"output_tokens"`
	CostUSD       float64    `json:"cost_usd"`
	InputCostUSD  float64    `json:"input_cost_usd"`
	OutputCostUSD float64    `json:"output_cost_usd"`
	LatencyMS     uint32     `json:"latency_ms"`
	TTFTMS       *uint32    `json:"ttft_ms,omitempty"`
	Status       string     `json:"status"`
	ErrorMessage *string    `json:"error_message,omitempty"`
	InputText    string     `json:"input_text"`
	OutputText   string     `json:"output_text"`
	FeatureName  *string    `json:"feature_name,omitempty"`
	UserID       *string    `json:"user_id,omitempty"`
	SessionID    *string    `json:"session_id,omitempty"`
	Environment  string     `json:"environment"`
	SDKVersion    string     `json:"sdk_version,omitempty"`
	Extra         *string    `json:"extra,omitempty"`
	PromptVersion *string    `json:"prompt_version,omitempty"`
	// "llm" or "workflow" — see schemas/clickhouse/004_span_kind.sql.
	// Trace tree consumers (frontend tree + gantt views) render workflow
	// rows differently (no model badge, no cost summary) because they're
	// synthetic containers, not provider calls.
	Kind string `json:"kind"`
}

type traceTreeResponseJSON struct {
	Spans []traceSpanJSON `json:"spans"`
}

// GetTraceTreeHTTP serves GET /api/v1/traces/tree/{trace_id} — returns every
// span belonging to the trace. The frontend builds the hierarchy from
// parent_span_id locally; we just hand back the flat list ordered by time.
func (s *Server) GetTraceTreeHTTP(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}

	if r.URL.Query().Get("org_id") != claims.OrgID {
		// Match GetTrace's behaviour: 404 not 403, to avoid org enumeration.
		problem.Write(w, http.StatusNotFound, "Not Found", "trace not found")
		return
	}

	traceID := chi.URLParam(r, "trace_id")
	if traceID == "" {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "trace_id is required")
		return
	}

	isOwner := claims.PrincipalClass == "owner"

	// Optional time window hint to bound the ClickHouse scan. The frontend
	// usually knows roughly when this trace happened (it came from a page
	// with a date range) — passing it through saves a probe round-trip and
	// cuts the partition footprint of the main query by ~89/90 days.
	var hintFrom, hintTo time.Time
	if v := r.URL.Query().Get("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			hintFrom = t
		}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			hintTo = t
		}
	}

	spans, err := query.TraceTree(r.Context(), s.CH, claims.OrgID, traceID, isOwner, hintFrom, hintTo)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "trace tree query failed")
		return
	}
	if len(spans) == 0 {
		problem.Write(w, http.StatusNotFound, "Not Found", "trace not found")
		return
	}

	resp := traceTreeResponseJSON{Spans: make([]traceSpanJSON, 0, len(spans))}
	for _, s := range spans {
		resp.Spans = append(resp.Spans, traceSpanJSON{
			OrgID:        s.OrgID,
			TraceID:      s.TraceID,
			SpanID:       s.SpanID,
			ParentSpanID: s.ParentSpanID,
			Timestamp:    s.Timestamp,
			Model:        s.Model,
			Provider:     s.Provider,
			InputTokens:   s.InputTokens,
			OutputTokens:  s.OutputTokens,
			CostUSD:       s.CostUSD,
			InputCostUSD:  s.InputCostUSD,
			OutputCostUSD: s.OutputCostUSD,
			LatencyMS:     s.LatencyMS,
			TTFTMS:       s.TTFTMS,
			Status:       s.Status,
			ErrorMessage: s.ErrorMessage,
			InputText:    s.InputText,
			OutputText:   s.OutputText,
			FeatureName:  s.FeatureName,
			UserID:       s.UserID,
			SessionID:    s.SessionID,
			Environment:  s.Environment,
			SDKVersion:    s.SDKVersion,
			Extra:         s.Extra,
			PromptVersion: s.PromptVersion,
			Kind:          s.Kind,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
