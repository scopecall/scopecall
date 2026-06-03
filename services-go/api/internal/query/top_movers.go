package query

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// TopMoverRow captures the period-over-period change for one dimension value.
// "Current" is the requested window; "Prior" is the same-sized window
// immediately preceding it.
type TopMoverRow struct {
	Key             string
	CurrentCostUSD  float64
	PriorCostUSD    float64
	DeltaCostUSD    float64
	CurrentCalls    uint64
	PriorCalls      uint64
	CurrentP99MS    float64
	PriorP99MS      float64
	DeltaP99MS      float64
}

// TopMovers returns the N dimension values with the biggest cost change between
// the current window and the equivalent prior window. The window comparison is
// the bedrock signal for "is something different today?" — without it the
// Metrics page can only tell you "X happened", never "X changed".
func TopMovers(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, groupBy string, limit int) ([]TopMoverRow, error) {
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}

	// Compute the equivalent prior window: same duration, immediately preceding.
	duration := tw.To.Sub(tw.From)
	priorFrom := tw.From.Add(-duration)

	// Same dim column mapping as the Breakdown query — keep them in sync.
	var col string
	switch groupBy {
	case "model":
		col = "model"
	case "provider":
		col = "provider"
	case "feature":
		col = "coalesce(feature_name, '')"
	case "user":
		col = "coalesce(user_id, '')"
	case "environment":
		col = "environment"
	default:
		return nil, fmt.Errorf("invalid group_by: %q", groupBy)
	}

	// Single scan over the union of both windows (prior_from..to) with conditional
	// aggregates per side. Reads raw llm_calls (rollup doesn't carry the quantile
	// state needed for prior-window p99) — fine because the time bound is small.
	q := fmt.Sprintf(`
SELECT
    %s                                                                        AS key,
    sumIf(cost_usd,    timestamp >= {from:DateTime('UTC')}       AND timestamp < {to:DateTime('UTC')})       AS curr_cost,
    sumIf(cost_usd,    timestamp >= {prior_from:DateTime('UTC')} AND timestamp < {from:DateTime('UTC')})     AS prior_cost,
    countIf(           timestamp >= {from:DateTime('UTC')}       AND timestamp < {to:DateTime('UTC')})       AS curr_calls,
    countIf(           timestamp >= {prior_from:DateTime('UTC')} AND timestamp < {from:DateTime('UTC')})     AS prior_calls,
    ifNotFinite(quantileIf(0.99)(latency_ms, timestamp >= {from:DateTime('UTC')}       AND timestamp < {to:DateTime('UTC')}),   0) AS curr_p99,
    ifNotFinite(quantileIf(0.99)(latency_ms, timestamp >= {prior_from:DateTime('UTC')} AND timestamp < {from:DateTime('UTC')}), 0) AS prior_p99
FROM llm_calls
-- kind='llm' — period-over-period cost change is an LLM metric.
-- See overview.go for the workflow-row-pollution rationale.
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {prior_from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
GROUP BY key
HAVING curr_cost > 0 OR prior_cost > 0
ORDER BY abs(curr_cost - prior_cost) DESC
LIMIT %d`, col, limit)

	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		driver.NamedValue{Name: "prior_from", Value: chDateTime(priorFrom)},
	)
	if err != nil {
		return nil, fmt.Errorf("top-movers query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]TopMoverRow, 0, limit)
	for rows.Next() {
		var r TopMoverRow
		if err := rows.Scan(
			&r.Key,
			&r.CurrentCostUSD, &r.PriorCostUSD,
			&r.CurrentCalls, &r.PriorCalls,
			&r.CurrentP99MS, &r.PriorP99MS,
		); err != nil {
			return nil, fmt.Errorf("scan top-mover: %w", err)
		}
		r.DeltaCostUSD = r.CurrentCostUSD - r.PriorCostUSD
		r.DeltaP99MS = r.CurrentP99MS - r.PriorP99MS
		out = append(out, r)
	}
	return out, rows.Err()
}
