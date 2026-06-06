package query

import (
	"context"
	"fmt"
	"strconv"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// WorkflowCostNode is one workflow's cost rollup across all of its LLM calls in
// the current window, with the same-sized prior window for delta computation.
//
// "Workflow" here = the feature_name on the kind='workflow' span that roots
// each trace. We DON'T trust the SDK-supplied cost on those container rows —
// the processor zeroes them deliberately (see reprice() in enricher.rs).
// Instead we sum the cost of the kind='llm' rows attributed to each workflow
// via trace_id join, which is the source of truth for cost.
type WorkflowCostNode struct {
	Name           string  // workflow feature_name; empty when a trace has no workflow root
	CurrentCostUSD float64 // sum of cost_usd over kind='llm' rows in this workflow, current window
	PriorCostUSD   float64 // same, prior window
	CurrentCalls   uint64  // count of kind='llm' rows in this workflow, current window
	ErrorCount     uint64  // count where status='error', current window
	CustomerCount  uint64  // distinct customer_id, current window — proxy for "how broad is this workflow"
	IsTestShare    float64 // fraction of current-window LLM rows that have is_test=true (0..1)
}

// WorkflowCostTree returns workflow-level cost rollups for the treemap on the
// Overview page. The query is intentionally a single scan over the
// (prior_from..to) range with conditional aggregates per side — same shape as
// TopMovers — so the treemap can be rendered without a follow-up call to get
// the prior-period baseline.
//
// Trace-to-workflow attribution uses a self-join on trace_id:
//   - Inner subquery picks one (trace_id → workflow_name) per trace from the
//     kind='workflow' rows. argMin(feature_name, timestamp) handles the
//     pathological case of a trace_id that somehow has multiple workflow
//     spans (shouldn't happen, but the SDK doesn't structurally prevent it
//     and we'd rather pick one deterministically than double-count cost).
//   - Outer aggregate sums cost over kind='llm' rows joined to that mapping.
//
// Traces that have LLM rows but NO workflow span (pre-v0.3 SDK, or a caller
// that used sdk.record_llm_call() bare) collapse into the "" workflow_name
// bucket — surfaced on the frontend as an "Unattributed" tile so the user
// can see how much cost is escaping the cost-attribution model.
func WorkflowCostTree(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, limit int) ([]WorkflowCostNode, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	duration := tw.To.Sub(tw.From)
	priorFrom := tw.From.Add(-duration)

	// Two-window scan. The workflow-mapping subquery spans the union of both
	// windows (prior_from..to) so a workflow span emitted in the prior window
	// still attributes its child LLM rows correctly. Workflow rows are cheap
	// (zero cost, tiny payload), so the extra range scan on them is fine.
	//
	// `limit` is passed as a CH parameter ({lim:UInt32}) rather than spliced
	// via fmt.Sprintf — the handler clamps the user input upstream, but
	// parameter-binding keeps the SQL safe even if a future refactor moves
	// the clamp. Same change applied to customer_profitability and
	// cost_confidence.
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
    coalesce(wm.workflow_name, '')                                                                            AS name,
    sumIf(l.cost_usd, l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})     AS curr_cost,
    sumIf(l.cost_usd, l.timestamp >= {prior_from:DateTime('UTC')} AND l.timestamp < {from:DateTime('UTC')})   AS prior_cost,
    countIf(          l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})     AS curr_calls,
    countIf(l.status = 'error'
            AND       l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})     AS errors,
    uniqExactIf(coalesce(l.customer_id, ''),
                    l.timestamp >= {from:DateTime('UTC')}         AND l.timestamp < {to:DateTime('UTC')}
                    AND l.customer_id IS NOT NULL AND l.customer_id != '')                                    AS customers,
    ifNotFinite(
        countIf(l.is_test = true
                AND l.timestamp >= {from:DateTime('UTC')} AND l.timestamp < {to:DateTime('UTC')})
        / nullIf(countIf(l.timestamp >= {from:DateTime('UTC')} AND l.timestamp < {to:DateTime('UTC')}), 0),
        0)                                                                                                    AS test_share
FROM llm_calls l
LEFT JOIN workflow_map wm ON l.trace_id = wm.trace_id
WHERE l.org_id    = {org_id:String}
  AND l.kind      = 'llm'
  AND l.timestamp >= {prior_from:DateTime('UTC')}
  AND l.timestamp <  {to:DateTime('UTC')}
GROUP BY name
HAVING curr_cost > 0 OR prior_cost > 0
ORDER BY curr_cost DESC
LIMIT {lim:UInt32}`

	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		driver.NamedValue{Name: "prior_from", Value: chDateTime(priorFrom)},
		// CH named params are wire-transmitted as strings and cast server-side
		// per the {lim:UInt32} annotation — see types.go for the rationale.
		driver.NamedValue{Name: "lim", Value: strconv.Itoa(limit)},
	)
	if err != nil {
		return nil, fmt.Errorf("workflow-cost-tree query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]WorkflowCostNode, 0, limit)
	for rows.Next() {
		var n WorkflowCostNode
		if err := rows.Scan(
			&n.Name,
			&n.CurrentCostUSD, &n.PriorCostUSD,
			&n.CurrentCalls, &n.ErrorCount,
			&n.CustomerCount, &n.IsTestShare,
		); err != nil {
			return nil, fmt.Errorf("scan workflow-cost-tree row: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
