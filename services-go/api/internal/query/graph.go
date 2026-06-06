package query

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

const (
	defaultGraphNodeLimit = 20
	maxGraphNodeLimit     = 50
	// Edge cap is a multiple of the node cap — even a sparse graph can have
	// several edges per node, but we don't want hundreds of edges on the canvas.
	edgeLimitMultiplier = 3
)

// GraphNode is one aggregate operation in the flow graph.
// ID is `op|model` so the frontend can dedupe and the edges can reference it.
//
// `kind` distinguishes workflow-container nodes (from sdk.trace()) from
// LLM-call nodes (provider invocations). Workflow nodes have empty model,
// zero cost, and latency that reflects the whole trace block — they're
// containers, not provider calls. The frontend renders them differently
// so the user can visually parse "this is a workflow that fans out to
// these LLM calls" instead of seeing every node as a flat call.
type GraphNode struct {
	ID           string  `json:"id"`
	Op           string  `json:"op"`    // feature_name OR model (the "what" of the operation)
	Model        string  `json:"model"` // the actual LLM model; empty for workflow nodes
	Kind         string  `json:"kind"`  // "llm" | "workflow" — discriminator for rendering
	Calls        uint64  `json:"calls"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
	P99LatencyMS float64 `json:"p99_latency_ms"`
	ErrorCount   uint64  `json:"error_count"`
	ErrorRate    float64 `json:"error_rate"` // 0..1
}

// GraphEdge is a parent→child transition between two nodes, aggregated across
// all traces in the window. Pct is the share of `From`'s outbound traffic that
// went to `To` (so the edge thickness on the canvas reads as branching probability).
type GraphEdge struct {
	From  string  `json:"from"`
	To    string  `json:"to"`
	Count uint64  `json:"count"`
	Pct   float64 `json:"pct"` // 0..1, share of From's outbound traffic
}

type GraphResult struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// Graph builds the flow-map data: edge-first selection — find the top edges by
// transition count, then derive the node set from their endpoints. This
// guarantees a CONNECTED graph, which is the whole point of the view.
//
// Why edge-first (vs. top-N nodes by volume):
//
//	Most LLM-app traffic is single-call leaves (no parent, no children).
//	Picking nodes by call volume surfaces those leaves and drops every chain,
//	leaving the user staring at a disconnected stack. Picking edges first
//	guarantees every node displayed has at least one connection.
//
// Node identity = (coalesce(feature_name, model), model). When feature_name
// is set, that's the user's logical operation name ("summarize", "embed");
// otherwise we fall back to model so older SDK versions still produce a graph.
//
// Edge derivation = self-join on parent_span_id. We deliberately do NOT use
// temporal sequence because concurrent spans in one trace would generate
// spurious edges. parent→child is the structural truth.
func Graph(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, limit int) (*GraphResult, error) {
	if limit <= 0 {
		limit = defaultGraphNodeLimit
	}
	if limit > maxGraphNodeLimit {
		limit = maxGraphNodeLimit
	}
	edgeLimit := limit * edgeLimitMultiplier

	// ---- 1. Top edges (with pct of source's outbound traffic) ----
	edgeQ := fmt.Sprintf(`
WITH calls AS (
    SELECT
        span_id,
        parent_span_id,
        concat(coalesce(nullIf(feature_name, ''), model), '|', model) AS id
    FROM llm_calls
    WHERE org_id = {org_id:String}
      AND timestamp >= {from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
)
SELECT
    p.id                                                            AS from_id,
    c.id                                                            AS to_id,
    count()                                                         AS cnt,
    ifNotFinite(count() / sum(count()) OVER (PARTITION BY p.id), 0) AS pct
FROM calls c
INNER JOIN calls p ON c.parent_span_id = p.span_id
GROUP BY from_id, to_id
ORDER BY cnt DESC
LIMIT %d`, edgeLimit)

	edgeRows, err := ch.Query(ctx, edgeQ,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, fmt.Errorf("graph edges query: %w", err)
	}
	defer edgeRows.Close() //nolint:errcheck

	res := &GraphResult{}
	nodeIDs := make(map[string]struct{})
	for edgeRows.Next() {
		var e GraphEdge
		if err := edgeRows.Scan(&e.From, &e.To, &e.Count, &e.Pct); err != nil {
			return nil, fmt.Errorf("scan graph edge: %w", err)
		}
		res.Edges = append(res.Edges, e)
		nodeIDs[e.From] = struct{}{}
		nodeIDs[e.To] = struct{}{}
	}
	if err := edgeRows.Err(); err != nil {
		return nil, fmt.Errorf("graph edges rows: %w", err)
	}

	// No edges in this window — fall back to top-N nodes by volume so the user
	// at least sees something (rather than a blank canvas). The single-node
	// hint on the frontend handles the "lonely circle" case.
	if len(nodeIDs) == 0 {
		return fallbackTopNodes(ctx, ch, orgID, tw, limit)
	}

	// Cap the displayed node set — if the edge query returned a huge variety
	// of endpoints, keep the most-connected ones (counted by edge participation).
	if len(nodeIDs) > limit {
		nodeIDs = pruneToMostConnected(res.Edges, limit)
		// Re-filter edges to the pruned node set.
		filtered := res.Edges[:0]
		for _, e := range res.Edges {
			if _, ok := nodeIDs[e.From]; !ok {
				continue
			}
			if _, ok := nodeIDs[e.To]; !ok {
				continue
			}
			filtered = append(filtered, e)
		}
		res.Edges = filtered
	}

	// ---- 2. Node aggregates for the selected set ----
	// Build a values list ClickHouse can match against. The node IDs are
	// concat(feature_name, '|', model) from CH-scanned rows — feature_name
	// is SDK-controlled, so escaping has to handle both `'` AND `\`. Use
	// the shared quotedINList helper (same as graph_expand) — see its
	// doc-comment for the order-matters reasoning. (Was a sister-bug to B1
	// that lived in this file and slipped past all 3 review passes; live
	// adversarial test caught it via a poisoned feature_name round-trip.)
	idSlice := make([]string, 0, len(nodeIDs))
	for id := range nodeIDs {
		idSlice = append(idSlice, id)
	}
	idList := quotedINList(idSlice)
	nodeQ := fmt.Sprintf(`
SELECT
    concat(op, '|', model)                                          AS id,
    op,
    model,
    kind,
    count()                                                         AS calls,
    sum(cost_usd)                                                   AS cost,
    avg(latency_ms)                                                 AS avg_lat,
    toFloat64(quantileExact(0.99)(latency_ms))                      AS p99_lat,
    countIf(status = 'error')                                       AS errors,
    ifNotFinite(countIf(status = 'error') / count(), 0)             AS err_rate
FROM (
    SELECT
        coalesce(nullIf(feature_name, ''), model) AS op,
        model,
        kind,
        latency_ms,
        cost_usd,
        status
    FROM llm_calls
    WHERE org_id = {org_id:String}
      AND timestamp >= {from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
)
-- Group by (op, model, kind) so workflow rows (model="") and any
-- accidentally-empty-model LLM rows can never collapse together.
-- Practically the model column already discriminates them, but
-- explicit-beats-implicit at the aggregation layer.
GROUP BY op, model, kind
HAVING id IN (%s)`, idList)

	nodeRows, err := ch.Query(ctx, nodeQ,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, fmt.Errorf("graph nodes query: %w", err)
	}
	defer nodeRows.Close() //nolint:errcheck

	for nodeRows.Next() {
		var n GraphNode
		if err := nodeRows.Scan(
			&n.ID, &n.Op, &n.Model, &n.Kind, &n.Calls, &n.TotalCostUSD,
			&n.AvgLatencyMS, &n.P99LatencyMS, &n.ErrorCount, &n.ErrorRate,
		); err != nil {
			return nil, fmt.Errorf("scan graph node: %w", err)
		}
		res.Nodes = append(res.Nodes, n)
	}
	if err := nodeRows.Err(); err != nil {
		return nil, fmt.Errorf("graph nodes rows: %w", err)
	}

	return res, nil
}

// pruneToMostConnected keeps the `limit` node IDs with the highest edge
// participation (sum of in-degree + out-degree weighted by edge count). The
// rest get dropped along with edges that touch them.
func pruneToMostConnected(edges []GraphEdge, limit int) map[string]struct{} {
	weight := make(map[string]uint64)
	for _, e := range edges {
		weight[e.From] += e.Count
		weight[e.To] += e.Count
	}
	type entry struct {
		id string
		w  uint64
	}
	all := make([]entry, 0, len(weight))
	for id, w := range weight {
		all = append(all, entry{id, w})
	}
	// Simple O(n²) selection — node sets are bounded (max ~150) so this is fine.
	keep := make(map[string]struct{}, limit)
	for i := 0; i < limit && len(all) > 0; i++ {
		maxIdx := 0
		for j := 1; j < len(all); j++ {
			if all[j].w > all[maxIdx].w {
				maxIdx = j
			}
		}
		keep[all[maxIdx].id] = struct{}{}
		all = append(all[:maxIdx], all[maxIdx+1:]...)
	}
	return keep
}

// fallbackTopNodes covers the "no edges in the window" case so the user
// sees their top operations rather than a blank canvas. No edges are returned.
func fallbackTopNodes(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, limit int) (*GraphResult, error) {
	q := fmt.Sprintf(`
SELECT
    concat(op, '|', model)                                          AS id,
    op,
    model,
    kind,
    count()                                                         AS calls,
    sum(cost_usd)                                                   AS cost,
    avg(latency_ms)                                                 AS avg_lat,
    toFloat64(quantileExact(0.99)(latency_ms))                      AS p99_lat,
    countIf(status = 'error')                                       AS errors,
    ifNotFinite(countIf(status = 'error') / count(), 0)             AS err_rate
FROM (
    SELECT
        coalesce(nullIf(feature_name, ''), model) AS op,
        model,
        kind,
        latency_ms,
        cost_usd,
        status
    FROM llm_calls
    WHERE org_id = {org_id:String}
      AND timestamp >= {from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
)
GROUP BY op, model, kind
ORDER BY calls DESC
LIMIT %d`, limit)

	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, fmt.Errorf("graph fallback nodes query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	res := &GraphResult{}
	for rows.Next() {
		var n GraphNode
		if err := rows.Scan(
			&n.ID, &n.Op, &n.Model, &n.Kind, &n.Calls, &n.TotalCostUSD,
			&n.AvgLatencyMS, &n.P99LatencyMS, &n.ErrorCount, &n.ErrorRate,
		); err != nil {
			return nil, fmt.Errorf("scan fallback node: %w", err)
		}
		res.Nodes = append(res.Nodes, n)
	}
	return res, rows.Err()
}
