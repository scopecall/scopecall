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

type expandedCallJSON struct {
	SpanID       string  `json:"span_id"`
	TraceID      string  `json:"trace_id"`
	ParentSpanID string  `json:"parent_span_id"`
	Op           string  `json:"op"`
	Model        string  `json:"model"`
	Status       string  `json:"status"`
	LatencyMS    uint32  `json:"latency_ms"`
	CostUSD      float64 `json:"cost_usd"`
	Timestamp    string  `json:"timestamp"`
	IsFocus      bool    `json:"is_focus"`
}

type expandResponseJSON struct {
	Calls []expandedCallJSON `json:"calls"`
}

// GetGraphExpandHTTP serves GET /api/v1/graph/expand — call-level breakdown
// of an aggregate node identified by (op, model). Returns focus calls plus
// their immediate parents/children (marked is_focus=false) so the frontend
// can render the actual call topology inside the aggregate.
func (s *Server) GetGraphExpandHTTP(w http.ResponseWriter, r *http.Request) {
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
	op := q.Get("op")
	// model="" is INTENTIONAL for workflow-node expansion. Workflow rows
	// have model="" (server-normalised), so a user clicking a workflow
	// node on the Flow Map sends op=feature&model= and expects the
	// workflow's spans + LLM children back. The ExpandNode query's
	// `model = {model:String}` predicate handles this correctly — it
	// matches workflow rows when model is "" and LLM rows otherwise.
	// Only `op` is structurally required (rejecting empty op would
	// match every node in the graph). Caught when seeded data made
	// workflow nodes visible — clicking them returned 400. (Round-5.)
	model := q.Get("model")
	if op == "" {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'op' is required")
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
	limit := 0
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	calls, err := query.ExpandNode(r.Context(), s.CH, claims.OrgID, op, model, query.TimeWindow{From: from, To: to}, limit)
	if err != nil {
		// Don't echo CH errors. TODO: structured logging.
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "expand failed")
		return
	}

	resp := expandResponseJSON{Calls: make([]expandedCallJSON, 0, len(calls))}
	for _, c := range calls {
		resp.Calls = append(resp.Calls, expandedCallJSON{
			SpanID: c.SpanID, TraceID: c.TraceID, ParentSpanID: c.ParentSpanID,
			Op: c.Op, Model: c.Model, Status: c.Status,
			LatencyMS: c.LatencyMS, CostUSD: c.CostUSD,
			Timestamp: c.Timestamp.Format(time.RFC3339),
			IsFocus:   c.IsFocus,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

type graphNodeJSON struct {
	ID           string  `json:"id"`
	Op           string  `json:"op"`
	Model        string  `json:"model"`
	// "llm" | "workflow" — discriminator the Flow Map's frontend uses to
	// render workflow containers as squares vs LLM calls as circles. This
	// hand-defined response struct shadowed query.GraphNode.Kind in
	// rounds 4 — the field existed in the query layer and the CH result,
	// but was silently dropped on JSON serialization. Frontend treated
	// every node as "llm" (the undefined-→-llm fallback). Caught by
	// seeder-verification: workflow nodes had model="" but no kind tag
	// on the wire. Keep this list in lockstep with query.GraphNode.
	Kind         string  `json:"kind"`
	Calls        uint64  `json:"calls"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
	P99LatencyMS float64 `json:"p99_latency_ms"`
	ErrorCount   uint64  `json:"error_count"`
	ErrorRate    float64 `json:"error_rate"`
}

type graphEdgeJSON struct {
	From  string  `json:"from"`
	To    string  `json:"to"`
	Count uint64  `json:"count"`
	Pct   float64 `json:"pct"`
}

type graphResponseJSON struct {
	Nodes []graphNodeJSON `json:"nodes"`
	Edges []graphEdgeJSON `json:"edges"`
}

// GetGraphHTTP serves GET /api/v1/graph — aggregate flow-map data for the
// time window. Returns top-N nodes (operations) by call volume plus every
// parent→child edge between any two retained nodes. Powers the Flow Map page.
func (s *Server) GetGraphHTTP(w http.ResponseWriter, r *http.Request) {
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

	limit := 0
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	res, err := query.Graph(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, limit)
	if err != nil {
		// Don't echo CH errors — leaks column names and query fragments.
		// TODO: structured logging when we add a logger to Server.
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "graph query failed")
		return
	}

	resp := graphResponseJSON{
		Nodes: make([]graphNodeJSON, 0, len(res.Nodes)),
		Edges: make([]graphEdgeJSON, 0, len(res.Edges)),
	}
	for _, n := range res.Nodes {
		resp.Nodes = append(resp.Nodes, graphNodeJSON{
			ID: n.ID, Op: n.Op, Model: n.Model, Kind: n.Kind, Calls: n.Calls,
			TotalCostUSD: n.TotalCostUSD,
			AvgLatencyMS: n.AvgLatencyMS, P99LatencyMS: n.P99LatencyMS,
			ErrorCount: n.ErrorCount, ErrorRate: n.ErrorRate,
		})
	}
	for _, e := range res.Edges {
		resp.Edges = append(resp.Edges, graphEdgeJSON{
			From: e.From, To: e.To, Count: e.Count, Pct: e.Pct,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
