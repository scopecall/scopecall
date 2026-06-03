package query

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

const (
	defaultBreakdownLimit = 50
	maxBreakdownLimit     = 100
)

// BreakdownRow is one group in a cost/call breakdown. Key2 is empty in
// single-dimension mode; populated only when a secondary dimension is requested.
type BreakdownRow struct {
	Key            string
	Key2           string
	Calls          uint64
	TotalCostUSD   float64
	AvgCostPerCall float64
	ErrorCount     uint64
	PctOfTotal     float64
}

type BreakdownResult struct {
	Rows         []BreakdownRow
	TotalCostUSD float64
	TotalCalls   uint64
}

// rollupColumns maps a group_by dimension to its column in llm_metrics_hourly.
var rollupColumns = map[string]string{
	"model":    "model",
	"provider": "provider",
	"feature":  "feature_name",
}

// rawColumns maps a group_by dimension to a column expression on llm_calls.
// High-cardinality dims that we don't pre-aggregate live here.
var rawColumns = map[string]string{
	"user":        "coalesce(user_id, '')",
	"environment": "environment",
}

// llmCallsColumns is the unified mapping for raw llm_calls queries (used for the
// raw path single-dim AND every cross-dim case — since the rollup doesn't carry
// user/env columns, cross-dim always reads raw for correctness).
var llmCallsColumns = map[string]string{
	"model":       "model",
	"provider":    "provider",
	"feature":     "coalesce(feature_name, '')",
	"user":        "coalesce(user_id, '')",
	"environment": "environment",
}

// Breakdown aggregates cost and calls by one dimension (single-dim mode) or
// two dimensions (cross-dim mode when secondary != "").
//
// Single-dim model/provider/feature hits the hourly rollup (cheap, scales
// forever). Single-dim user/environment AND every cross-dim case scan raw
// llm_calls (rollup lacks user/env columns).
func Breakdown(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, groupBy, secondary string, limit int) (*BreakdownResult, error) {
	if limit <= 0 {
		limit = defaultBreakdownLimit
	}
	if limit > maxBreakdownLimit {
		limit = maxBreakdownLimit
	}

	if secondary != "" && secondary == groupBy {
		return nil, fmt.Errorf("secondary_group_by must differ from group_by")
	}

	var q string
	switch {
	case secondary != "":
		// Cross-dim mode: always read raw llm_calls for correctness (rollup
		// doesn't have user/env columns; conditional branching would be a
		// false economy here given the bounded time window).
		col1, ok1 := llmCallsColumns[groupBy]
		col2, ok2 := llmCallsColumns[secondary]
		if !ok1 || !ok2 {
			return nil, fmt.Errorf("invalid group_by/secondary_group_by combination: %q × %q", groupBy, secondary)
		}
		// Cross-dim cardinality bound: when key2 is user_id, an org with
		// millions of distinct end-users would make ClickHouse hold all
		// intermediate hash-table state in memory before LIMIT. Spill to disk
		// when the hash table exceeds 1 GiB. (T-6 from fourth-pass review.)
		q = fmt.Sprintf(`
SELECT
    %s                                                  AS key,
    %s                                                  AS key2,
    count()                                             AS calls,
    sum(cost_usd)                                       AS cost,
    countIf(status = 'error')                           AS errors,
    ifNotFinite(sum(cost_usd) / count(), 0)             AS avg_cost,
    ifNotFinite(sum(cost_usd) / sum(sum(cost_usd)) OVER () * 100, 0) AS pct,
    sum(sum(cost_usd)) OVER ()                          AS grand_cost,
    sum(count()) OVER ()                                AS grand_calls
FROM llm_calls
-- kind = 'llm': cost breakdown by dimension only makes sense over
-- provider calls. Workflow rows have cost_usd=0 so wouldn't pollute the
-- sums, but they would inflate call counts and pct-of-total grand totals.
-- See overview.go for the broader workflow-row-pollution rationale.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
GROUP BY key, key2
ORDER BY cost DESC
LIMIT %d
SETTINGS max_bytes_before_external_group_by = 1073741824`, col1, col2, limit)

	case rollupColumns[groupBy] != "":
		q = fmt.Sprintf(`
SELECT
    %s                                                              AS key,
    ''                                                              AS key2,
    sum(call_count)                                                 AS calls,
    sum(total_cost_usd)                                             AS cost,
    sum(error_count)                                                AS errors,
    ifNotFinite(sum(total_cost_usd) / sum(call_count), 0)           AS avg_cost,
    ifNotFinite(sum(total_cost_usd) / sum(sum(total_cost_usd)) OVER () * 100, 0) AS pct,
    sum(sum(total_cost_usd)) OVER ()                                AS grand_cost,
    sum(sum(call_count)) OVER ()                                    AS grand_calls
FROM llm_metrics_hourly
WHERE org_id = {org_id:String}
  AND hour >= {from:DateTime('UTC')}
  AND hour <  {to:DateTime('UTC')}
GROUP BY key
ORDER BY cost DESC
LIMIT %d`, rollupColumns[groupBy], limit)

	case rawColumns[groupBy] != "":
		q = fmt.Sprintf(`
SELECT
    %s                                                  AS key,
    ''                                                  AS key2,
    count()                                             AS calls,
    sum(cost_usd)                                       AS cost,
    countIf(status = 'error')                           AS errors,
    ifNotFinite(sum(cost_usd) / count(), 0)             AS avg_cost,
    ifNotFinite(sum(cost_usd) / sum(sum(cost_usd)) OVER () * 100, 0) AS pct,
    sum(sum(cost_usd)) OVER ()                          AS grand_cost,
    sum(count()) OVER ()                                AS grand_calls
FROM llm_calls
-- kind = 'llm': cost breakdown by dimension only makes sense over
-- provider calls. Workflow rows have cost_usd=0 so wouldn't pollute the
-- sums, but they would inflate call counts and pct-of-total grand totals.
-- See overview.go for the broader workflow-row-pollution rationale.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
GROUP BY key
ORDER BY cost DESC
LIMIT %d`, rawColumns[groupBy], limit)

	default:
		return nil, fmt.Errorf("invalid group_by: %q", groupBy)
	}

	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, fmt.Errorf("breakdown query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	res := &BreakdownResult{}
	for rows.Next() {
		var r BreakdownRow
		var grandCost float64
		var grandCalls uint64
		if err := rows.Scan(
			&r.Key, &r.Key2, &r.Calls, &r.TotalCostUSD, &r.ErrorCount,
			&r.AvgCostPerCall, &r.PctOfTotal, &grandCost, &grandCalls,
		); err != nil {
			return nil, fmt.Errorf("scan breakdown row: %w", err)
		}
		res.Rows = append(res.Rows, r)
		res.TotalCostUSD = grandCost
		res.TotalCalls = grandCalls
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("breakdown rows: %w", err)
	}
	return res, nil
}
