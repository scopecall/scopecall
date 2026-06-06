package query

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// AlertTraceRow is one offending trace surfaced under an alert event — the
// concrete "you should look at this one" sample that closes the loop between
// an alert firing and the user actually debugging the cause.
type AlertTraceRow struct {
	TraceID     string    `json:"trace_id"`
	SpanID      string    `json:"span_id"` // representative span (most expensive/slowest/errored)
	Model       string    `json:"model"`
	FeatureName string    `json:"feature_name,omitempty"`
	Status      string    `json:"status"`
	LatencyMS   uint32    `json:"latency_ms"`
	CostUSD     float64   `json:"cost_usd"`    // trace total
	ErrorCount  uint32    `json:"error_count"` // spans with status=error in the trace
	Timestamp   time.Time `json:"timestamp"`
}

// SampleTracesForAlert returns the top N traces that contributed to an alert
// event firing — picked from the rule's evaluation window. Ranking depends on
// rule type: cost_spike → by trace cost desc, latency_p99 → by max latency desc,
// error_rate → by error count desc + recency.
//
// dimFilter scopes the search to whatever the rule was watching (e.g. model=X,
// feature_name=Y). Empty filter = whole org. The window matches the evaluator's
// own logic: [fired_at - window_seconds, fired_at].
func SampleTracesForAlert(
	ctx context.Context,
	ch driver.Conn,
	orgID string,
	ruleType string,
	dimFilter map[string]string,
	firedAt time.Time,
	windowSeconds int,
	limit int,
) ([]AlertTraceRow, error) {
	if limit <= 0 {
		limit = 5
	}
	if limit > 20 {
		limit = 20
	}

	from := firedAt.Add(-time.Duration(windowSeconds) * time.Second)

	// Build dim filter clauses. The keys we accept mirror what the evaluator
	// supports — keep this list in sync if you add new dim columns.
	var (
		dimClauses []string
		dimArgs    []driver.NamedValue
	)
	addDim := func(col, key string) {
		if v := dimFilter[key]; v != "" {
			dimClauses = append(dimClauses, fmt.Sprintf("%s = {%s:String}", col, key))
			dimArgs = append(dimArgs, driver.NamedValue{Name: key, Value: v})
		}
	}
	addDim("model", "model")
	addDim("provider", "provider")
	addDim("feature_name", "feature_name")
	addDim("environment", "environment")
	addDim("user_id", "user_id")

	dimSQL := ""
	if len(dimClauses) > 0 {
		dimSQL = " AND " + strings.Join(dimClauses, " AND ")
	}

	// Pick the ranking expression based on what the rule was firing on. We
	// aggregate at the trace level — one row per trace_id — because a "sample
	// trace" the user clicks should drop them into the trace tree, not one span.
	var rankExpr, repSpanExpr string
	switch ruleType {
	case "cost_spike":
		rankExpr = "sum(cost_usd) DESC"
		repSpanExpr = "argMax(span_id, cost_usd)" // most expensive span in the trace
	case "latency_p99":
		rankExpr = "max(latency_ms) DESC"
		repSpanExpr = "argMax(span_id, latency_ms)" // slowest span
	case "error_rate":
		// Only show traces that actually had an error; order by recency among
		// those so the user sees what's currently going wrong, not history.
		rankExpr = "max(timestamp) DESC"
		repSpanExpr = "argMaxIf(span_id, timestamp, status = 'error')"
	default:
		rankExpr = "max(timestamp) DESC"
		repSpanExpr = "any(span_id)"
	}

	errorFilter := ""
	if ruleType == "error_rate" {
		// Restrict to traces that had at least one error span — otherwise we'd
		// show successful traces under an "error rate" alert, which is nonsense.
		errorFilter = " HAVING countIf(status = 'error') > 0"
	}

	q := fmt.Sprintf(`
SELECT
    trace_id,
    %s                                          AS rep_span_id,
    any(model)                                  AS model,
    coalesce(any(feature_name), '')             AS feature_name,
    argMax(status, cost_usd)                    AS rep_status,
    max(latency_ms)                             AS max_lat,
    sum(cost_usd)                               AS total_cost,
    -- countIf returns UInt64; cast so the Go scan into uint32 works.
    toUInt32(countIf(status = 'error'))         AS err_count,
    min(timestamp)                              AS first_ts
FROM llm_calls
-- kind='llm' — alert events surface offending LLM calls. Workflow rows
-- don't carry model/cost the user expects to see in the alert detail.
-- See overview.go.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
  %s
GROUP BY trace_id
%s
ORDER BY %s
LIMIT %d`, repSpanExpr, dimSQL, errorFilter, rankExpr, limit)

	args := []any{
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(from)},
		driver.NamedValue{Name: "to", Value: chDateTime(firedAt)},
	}
	for _, a := range dimArgs {
		args = append(args, a)
	}

	rows, err := ch.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("alert traces query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]AlertTraceRow, 0, limit)
	for rows.Next() {
		var r AlertTraceRow
		if err := rows.Scan(
			&r.TraceID, &r.SpanID, &r.Model, &r.FeatureName,
			&r.Status, &r.LatencyMS, &r.CostUSD, &r.ErrorCount, &r.Timestamp,
		); err != nil {
			return nil, fmt.Errorf("scan alert trace row: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
