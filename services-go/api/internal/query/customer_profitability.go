package query

import (
	"context"
	"fmt"
	"strconv"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// CustomerProfitabilityRow is one B2B customer's cost rollup over the window.
// Aggregates kind='llm' rows grouped by customer_id; only rows with a non-empty
// customer_id are included — calls without customer attribution land in a
// separate "Unattributed" tile on the frontend (computed client-side via
// total_cost - sum(rows.current_cost)).
//
// Why these columns specifically: the "is this customer profitable?" lens needs
// (a) raw spend, (b) trend vs prior period, (c) waste signals (retry %, test %),
// (d) breadth (how many workflows / models — indicates stickiness). Anything
// else can be drilled into via the per-customer detail page later.
type CustomerProfitabilityRow struct {
	CustomerID       string
	CurrentCostUSD   float64
	PriorCostUSD     float64
	CurrentCalls     uint64
	ErrorCount       uint64
	WorkflowCount    uint64 // distinct workflow feature_names seen by this customer
	ModelCount       uint64 // distinct models
	RetryCostUSD     float64
	TestCostUSD      float64
	CacheReadSavings float64
}

// CustomerProfitability returns a per-customer cost rollup ordered by current
// cost descending. Bounded by `limit` (default 50) — past ~50 the long tail
// stops being actionable and the user should use search instead.
//
// "Workflow count" is computed via trace_id self-join: for each LLM row, we
// look up the kind='workflow' span on that trace_id (same pattern as the
// treemap), then uniqExact the workflow names per customer. We deliberately
// DO NOT lean on the LLM row's own feature_name column for this — that's the
// step or LLM-call name (whichever the SDK most recently propagated), not
// the enclosing workflow's name, so it would overcount.
func CustomerProfitability(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, limit int) ([]CustomerProfitabilityRow, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	duration := tw.To.Sub(tw.From)
	priorFrom := tw.From.Add(-duration)

	// `limit` passed as a CH parameter — see workflow_cost_tree.go for the
	// rationale (defense-in-depth against future refactors moving the clamp).
	q := `
WITH workflow_map AS (
    SELECT
        trace_id,
        argMin(coalesce(nullIf(feature_name, ''), ''), timestamp) AS workflow_name
    FROM llm_calls
    WHERE org_id    = {org_id:String}
      AND kind      = 'workflow'
      AND timestamp >= {prior_from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
    GROUP BY trace_id
)
SELECT
    l.customer_id                                                                                              AS customer,
    sumIf(l.cost_usd,            l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})       AS curr_cost,
    sumIf(l.cost_usd,            l.timestamp >= {prior_from:DateTime('UTC')} AND l.timestamp < {from:DateTime('UTC')})     AS prior_cost,
    countIf(                     l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})       AS curr_calls,
    countIf(l.status = 'error'
            AND                  l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})       AS errors,
    uniqExactIf(coalesce(wm.workflow_name, ''),
                                 l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')}
                                 AND wm.workflow_name IS NOT NULL AND wm.workflow_name != '')                              AS workflows,
    uniqExactIf(l.model,         l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')}
                                 AND l.model != '')                                                                        AS models,
    sumIf(l.cost_usd, l.attempt_number > 1
                                 AND l.timestamp >= {from:DateTime('UTC')}   AND l.timestamp < {to:DateTime('UTC')})       AS retry_cost,
    sumIf(l.cost_usd, l.is_test = true
                                 AND l.timestamp >= {from:DateTime('UTC')}   AND l.timestamp < {to:DateTime('UTC')})       AS test_cost,
    sumIf(l.cache_read_cost_usd, l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})       AS cache_savings
FROM llm_calls l
LEFT JOIN workflow_map wm ON l.trace_id = wm.trace_id
WHERE l.org_id    = {org_id:String}
  AND l.kind      = 'llm'
  AND l.customer_id IS NOT NULL
  AND l.customer_id != ''
  AND l.timestamp >= {prior_from:DateTime('UTC')}
  AND l.timestamp <  {to:DateTime('UTC')}
GROUP BY customer
HAVING curr_cost > 0 OR prior_cost > 0
ORDER BY curr_cost DESC
LIMIT {lim:UInt32}`

	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		driver.NamedValue{Name: "prior_from", Value: chDateTime(priorFrom)},
		// CH named params transmit as strings (see types.go).
		driver.NamedValue{Name: "lim", Value: strconv.Itoa(limit)},
	)
	if err != nil {
		return nil, fmt.Errorf("customer-profitability query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]CustomerProfitabilityRow, 0, limit)
	for rows.Next() {
		var r CustomerProfitabilityRow
		// customer_id is Nullable(String) in CH; we filter NULLs in WHERE but
		// scan into a *String to satisfy the driver. Empty-string sentinel
		// shouldn't occur given the != '' filter.
		var cust *string
		if err := rows.Scan(
			&cust,
			&r.CurrentCostUSD, &r.PriorCostUSD,
			&r.CurrentCalls, &r.ErrorCount,
			&r.WorkflowCount, &r.ModelCount,
			&r.RetryCostUSD, &r.TestCostUSD, &r.CacheReadSavings,
		); err != nil {
			return nil, fmt.Errorf("scan customer-profitability: %w", err)
		}
		if cust != nil {
			r.CustomerID = *cust
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CustomerProfitabilityTotals is the org-wide grand-total context, used by the
// frontend to compute (a) "% of total spend" per customer and (b) an
// "Unattributed" tile = grand_total - sum(per-customer costs).
type CustomerProfitabilityTotals struct {
	GrandTotalCostUSD       float64
	AttributedCostUSD       float64
	UnattributedCostUSD     float64
	AttributedCustomerCount uint64
}

// CustomerProfitabilityTotals returns the (grand total, attributed, unattributed)
// triple in a single CH query. Kept separate from the per-row rollup so the
// "Unattributed" tile can be computed without re-summing the truncated top-N
// list on the frontend (which would be wrong when the list is LIMIT-capped).
func CustomerProfitabilityTotalsQuery(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow) (*CustomerProfitabilityTotals, error) {
	q := `
SELECT
    sum(cost_usd)                                                                            AS grand_total,
    sumIf(cost_usd, customer_id IS NOT NULL AND customer_id != '')                           AS attributed,
    uniqExactIf(coalesce(customer_id, ''), customer_id IS NOT NULL AND customer_id != '')    AS distinct_customers
FROM llm_calls
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}`

	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, fmt.Errorf("customer-profitability totals query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	t := &CustomerProfitabilityTotals{}
	if rows.Next() {
		if err := rows.Scan(&t.GrandTotalCostUSD, &t.AttributedCostUSD, &t.AttributedCustomerCount); err != nil {
			return nil, fmt.Errorf("scan customer-profitability totals: %w", err)
		}
	}
	t.UnattributedCostUSD = t.GrandTotalCostUSD - t.AttributedCostUSD
	if t.UnattributedCostUSD < 0 {
		// Float subtraction can produce a tiny negative residual when
		// attributed ≈ grand_total — clamp so the frontend can't show "-$0.00".
		t.UnattributedCostUSD = 0
	}
	return t, rows.Err()
}
