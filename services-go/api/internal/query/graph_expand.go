package query

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

const (
	defaultExpandLimit = 50
	maxExpandLimit     = 100
)

// ExpandedCall is one individual LLM call surfaced inside a node's expanded view.
// IsFocus separates calls of the expanded (op, model) from context calls
// (parents/children of those focus calls) so the frontend can dim the context.
type ExpandedCall struct {
	SpanID       string    `json:"span_id"`
	TraceID      string    `json:"trace_id"`
	ParentSpanID string    `json:"parent_span_id"`
	Op           string    `json:"op"`
	Model        string    `json:"model"`
	Status       string    `json:"status"`
	LatencyMS    uint32    `json:"latency_ms"`
	CostUSD      float64   `json:"cost_usd"`
	Timestamp    time.Time `json:"timestamp"`
	IsFocus      bool      `json:"is_focus"`
}

// ExpandNode returns the call-level breakdown of an aggregate (op, model)
// node: up to `limit` focus calls (sorted by recency) plus their immediate
// parents and children. This is the "look inside" view that turns the
// abstract aggregate node into a real picture of how calls chain together.
//
// We hit ClickHouse twice — first for focus calls, then for context — because
// the context query needs the focus calls' span_ids and parent_span_ids
// computed from the first result set. A single CTE-based query is possible
// but harder to read and harder to debug when something misbehaves.
func ExpandNode(ctx context.Context, ch driver.Conn, orgID, op, model string, tw TimeWindow, limit int) ([]ExpandedCall, error) {
	if limit <= 0 {
		limit = defaultExpandLimit
	}
	if limit > maxExpandLimit {
		limit = maxExpandLimit
	}

	// ---- 1. Focus calls ----------------------------------------------------
	focusQ := fmt.Sprintf(`
SELECT
    span_id,
    trace_id,
    coalesce(parent_span_id, '')               AS parent_span_id,
    coalesce(nullIf(feature_name, ''), model)  AS op,
    model,
    status,
    latency_ms,
    cost_usd,
    timestamp
FROM llm_calls
WHERE org_id = {org_id:String}
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
  AND coalesce(nullIf(feature_name, ''), model) = {op:String}
  AND model = {model:String}
ORDER BY timestamp DESC
LIMIT %d`, limit)

	focusRows, err := ch.Query(ctx, focusQ,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		driver.NamedValue{Name: "op", Value: op},
		driver.NamedValue{Name: "model", Value: model},
	)
	if err != nil {
		return nil, fmt.Errorf("expand focus query: %w", err)
	}
	defer focusRows.Close() //nolint:errcheck

	var calls []ExpandedCall
	focusSpanIDs := make([]string, 0)
	parentSpanIDs := make([]string, 0)
	for focusRows.Next() {
		var c ExpandedCall
		if err := focusRows.Scan(
			&c.SpanID, &c.TraceID, &c.ParentSpanID, &c.Op, &c.Model,
			&c.Status, &c.LatencyMS, &c.CostUSD, &c.Timestamp,
		); err != nil {
			return nil, fmt.Errorf("scan focus call: %w", err)
		}
		c.IsFocus = true
		calls = append(calls, c)
		focusSpanIDs = append(focusSpanIDs, c.SpanID)
		if c.ParentSpanID != "" {
			parentSpanIDs = append(parentSpanIDs, c.ParentSpanID)
		}
	}
	if err := focusRows.Err(); err != nil {
		return nil, fmt.Errorf("focus rows: %w", err)
	}
	if len(calls) == 0 {
		return calls, nil
	}

	// ---- 2. Context calls (parents + children of focus) -------------------
	// Build quoted IN lists from the focus span_ids and parent_span_ids.
	// Values come from ClickHouse's own scan, so injection is impossible.
	focusIN := quotedINList(focusSpanIDs)
	parentIN := quotedINList(parentSpanIDs)

	var clauses []string
	if parentIN != "" {
		clauses = append(clauses, "span_id IN ("+parentIN+")")
	}
	if focusIN != "" {
		clauses = append(clauses, "parent_span_id IN ("+focusIN+")")
	}
	if len(clauses) == 0 {
		return calls, nil
	}

	// Don't re-fetch the focus calls themselves (parents-of-focus might include
	// another focus call if focus has multiple chained calls within the same op).
	contextQ := fmt.Sprintf(`
SELECT
    span_id,
    trace_id,
    coalesce(parent_span_id, '')               AS parent_span_id,
    coalesce(nullIf(feature_name, ''), model)  AS op,
    model,
    status,
    latency_ms,
    cost_usd,
    timestamp
FROM llm_calls
WHERE org_id = {org_id:String}
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
  AND span_id NOT IN (%s)
  AND (%s)`, focusIN, strings.Join(clauses, " OR "))

	contextRows, err := ch.Query(ctx, contextQ,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, fmt.Errorf("expand context query: %w", err)
	}
	defer contextRows.Close() //nolint:errcheck

	for contextRows.Next() {
		var c ExpandedCall
		if err := contextRows.Scan(
			&c.SpanID, &c.TraceID, &c.ParentSpanID, &c.Op, &c.Model,
			&c.Status, &c.LatencyMS, &c.CostUSD, &c.Timestamp,
		); err != nil {
			return nil, fmt.Errorf("scan context call: %w", err)
		}
		c.IsFocus = false
		calls = append(calls, c)
	}
	if err := contextRows.Err(); err != nil {
		return nil, fmt.Errorf("context rows: %w", err)
	}

	return calls, nil
}

// quotedINList builds a comma-joined `'val1','val2',...` list safe to splice
// into a ClickHouse IN clause.
//
// SECURITY: ClickHouse string literals accept BOTH `''` AND `\'` as escapes
// for a single quote. If we only doubled `'`, a value containing a trailing
// `\` would let an attacker break out of the string literal:
//
//	input:   `x\','BREAKOUT`
//	naive:   'x\','BREAKOUT'          // CH parses as two literals
//	correct: 'x\\','BREAKOUT'         // CH parses as one literal "x\\','BREAKOUT" — wait, still need...
//
// We must double `\` FIRST, then double `'`. The order matters: doubling `'`
// first leaves any leading backslashes intact, and CH then interprets `\''`
// as `\'` + `'` — closing the string.
//
// The matching test in graph_expand_test.go exercises both escapes.
func quotedINList(ss []string) string {
	if len(ss) == 0 {
		return ""
	}
	parts := make([]string, 0, len(ss))
	seen := make(map[string]struct{}, len(ss))
	for _, s := range ss {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		// Order is critical: backslashes first, then single quotes.
		escaped := strings.ReplaceAll(s, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, "'", "''")
		parts = append(parts, "'"+escaped+"'")
	}
	return strings.Join(parts, ",")
}
