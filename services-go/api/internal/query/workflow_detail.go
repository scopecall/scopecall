package query

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// WorkflowBreakdownRow is one (key, cost, calls, errors) triple in a workflow's
// per-dimension breakdown — used for agent / step / customer / model panels on
// the workflow detail page.
type WorkflowBreakdownRow struct {
	Key        string
	CostUSD    float64
	Calls      uint64
	ErrorCount uint64
}

// WorkflowSummary is the top-of-page rollup for a workflow detail view: total
// cost / calls / errors, distinct customer count, plus a few targeted
// callouts that the v0.3 cost-attribution thesis cares about (retry cost,
// test-traffic cost, cache-hit savings).
type WorkflowSummary struct {
	TotalCostUSD     float64
	PriorCostUSD     float64 // same-sized window immediately preceding
	TotalCalls       uint64
	ErrorCount       uint64
	CustomerCount    uint64
	RetryCostUSD     float64 // cost on calls where attempt_number > 1 — pure waste
	TestCostUSD      float64 // cost on calls where is_test=true — should not be in prod budget
	CacheReadSavings float64 // cache_read_cost_usd not paid because tokens hit cache
}

// WorkflowDetailResult is everything the workflow detail page needs in a
// single response. Each breakdown is bounded (top 20) so the response stays
// small.
type WorkflowDetailResult struct {
	Summary       WorkflowSummary
	ByAgent       []WorkflowBreakdownRow
	ByStep        []WorkflowBreakdownRow
	ByCustomer    []WorkflowBreakdownRow
	ByModel       []WorkflowBreakdownRow
	CostSourceMix []WorkflowBreakdownRow // server_computed vs sdk_fallback vs unknown_model — cost-confidence indicator
}

// WorkflowDetail returns a one-shot rollup for the workflow detail page.
//
// "This workflow" is defined as: the trace_ids that have a kind='workflow' row
// with feature_name == workflowName in the (prior_from..to) range. All
// breakdowns aggregate over kind='llm' rows attributed to those traces
// (cost lives on the LLM rows; workflow/agent/step container rows are
// zeroed by the processor — see reprice() in enricher.rs).
//
// Agent / step attribution handles both legitimate structural shapes:
//
//   - workflow → agent → step → llm    (canonical 3-level hierarchy)
//   - workflow → agent → llm           (no step wrapper — agent is the
//     direct parent of the LLM call)
//
// The by-agent breakdown coalesces both paths so cost from agents that
// don't subdivide into steps still attributes correctly (was previously
// silently bucketed into "(no agent)" — see the comment on byAgentQ).
// LLM rows with no agent ancestor at all (bare sdk.record_llm_call()
// inside a workflow but outside any sdk.agent() / sdk.step()) collapse
// into a "" bucket on each breakdown — surfaced as "(no agent)" /
// "(no step)" on the frontend so the gap is visible.
func WorkflowDetail(ctx context.Context, ch driver.Conn, orgID, workflowName string, tw TimeWindow) (*WorkflowDetailResult, error) {
	duration := tw.To.Sub(tw.From)
	priorFrom := tw.From.Add(-duration)

	// Parameter set reused by every sub-query. ClickHouse-go's Query() takes
	// ...any (variadic), so we keep a []any and splat with `args...` at every
	// call site. (Typed []NamedValue can't auto-convert to []any in Go.)
	args := []any{
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "workflow", Value: workflowName},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		driver.NamedValue{Name: "prior_from", Value: chDateTime(priorFrom)},
	}

	res := &WorkflowDetailResult{}

	// ── 1. Summary row (single scan over prior_from..to with conditional aggregates) ──
	summaryQ := `
WITH workflow_traces AS (
    SELECT DISTINCT trace_id
    FROM llm_calls
    WHERE org_id    = {org_id:String}
      AND kind      = 'workflow'
      AND coalesce(nullIf(feature_name, ''), '') = {workflow:String}
      AND timestamp >= {prior_from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
)
SELECT
    sumIf(l.cost_usd,           l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})      AS total_cost,
    sumIf(l.cost_usd,           l.timestamp >= {prior_from:DateTime('UTC')} AND l.timestamp < {from:DateTime('UTC')})    AS prior_cost,
    countIf(                    l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})      AS total_calls,
    countIf(l.status = 'error'
            AND                 l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})      AS errors,
    uniqExactIf(coalesce(l.customer_id, ''),
                                l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')}
                                AND l.customer_id IS NOT NULL AND l.customer_id != '')                                   AS customers,
    sumIf(l.cost_usd, l.attempt_number > 1
                                AND l.timestamp >= {from:DateTime('UTC')}   AND l.timestamp < {to:DateTime('UTC')})      AS retry_cost,
    sumIf(l.cost_usd, l.is_test = true
                                AND l.timestamp >= {from:DateTime('UTC')}   AND l.timestamp < {to:DateTime('UTC')})      AS test_cost,
    sumIf(l.cache_read_cost_usd,l.timestamp >= {from:DateTime('UTC')}       AND l.timestamp < {to:DateTime('UTC')})      AS cache_savings
FROM llm_calls l
INNER JOIN workflow_traces wt ON l.trace_id = wt.trace_id
WHERE l.org_id    = {org_id:String}
  AND l.kind      = 'llm'
  AND l.timestamp >= {prior_from:DateTime('UTC')}
  AND l.timestamp <  {to:DateTime('UTC')}`

	rows, err := ch.Query(ctx, summaryQ, args...) //nolint:gocritic // args is []any by design — see comment above
	if err != nil {
		return nil, fmt.Errorf("workflow-detail summary: %w", err)
	}
	if rows.Next() {
		if err := rows.Scan(
			&res.Summary.TotalCostUSD,
			&res.Summary.PriorCostUSD,
			&res.Summary.TotalCalls,
			&res.Summary.ErrorCount,
			&res.Summary.CustomerCount,
			&res.Summary.RetryCostUSD,
			&res.Summary.TestCostUSD,
			&res.Summary.CacheReadSavings,
		); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan workflow-detail summary: %w", err)
		}
	}
	// Check rows.Err() before closing — a driver error mid-read (network
	// blip, malformed row) leaves Next() returning false, and silently
	// dropping that would leave the summary as zeros on a partial failure.
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("workflow-detail summary rows: %w", err)
	}
	_ = rows.Close()

	// Common CTE prefix factored into a string — every breakdown selects from
	// the same workflow-trace + LLM-rows subset.
	breakdownPrefix := `
WITH workflow_traces AS (
    SELECT DISTINCT trace_id
    FROM llm_calls
    WHERE org_id    = {org_id:String}
      AND kind      = 'workflow'
      AND coalesce(nullIf(feature_name, ''), '') = {workflow:String}
      AND timestamp >= {prior_from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
),
agents AS (
    SELECT span_id, coalesce(nullIf(feature_name, ''), '') AS agent_name
    FROM llm_calls
    WHERE org_id    = {org_id:String}
      AND kind      = 'agent'
      AND trace_id IN (SELECT trace_id FROM workflow_traces)
      AND timestamp >= {prior_from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
),
steps AS (
    SELECT span_id, parent_span_id, coalesce(nullIf(feature_name, ''), '') AS step_name
    FROM llm_calls
    WHERE org_id    = {org_id:String}
      AND kind      = 'step'
      AND trace_id IN (SELECT trace_id FROM workflow_traces)
      AND timestamp >= {prior_from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
),
llms AS (
    SELECT
        l.parent_span_id,
        l.cost_usd,
        l.status,
        l.model,
        l.customer_id,
        l.cost_source
    FROM llm_calls l
    INNER JOIN workflow_traces wt ON l.trace_id = wt.trace_id
    WHERE l.org_id    = {org_id:String}
      AND l.kind      = 'llm'
      AND l.timestamp >= {from:DateTime('UTC')}
      AND l.timestamp <  {to:DateTime('UTC')}
)`

	// ── 2. By agent — TWO valid structural paths from an LLM call up to the
	//        enclosing agent, and we have to handle both:
	//
	//   (A) workflow → agent → step → llm   (the canonical 3-level shape)
	//       resolved via llm.parent_span_id → step.span_id,
	//                    step.parent_span_id → agent.span_id
	//
	//   (B) workflow → agent → llm          (no step wrapper; sdk.agent()
	//                                        followed by a bare LLM call)
	//       resolved via llm.parent_span_id → agent.span_id directly
	//
	//        Both are legitimate caller patterns. Falling back to (A) only
	//        bucketed (B)-shaped calls into "(no agent)" — i.e. silently
	//        misattributed any cost from agents whose work wasn't further
	//        subdivided into steps.
	//
	//        We coalesce: prefer the step-mediated path (agent identity
	//        through the canonical hierarchy), fall back to the direct
	//        path. Identical agent rows are merged in the outer GROUP BY.
	byAgentQ := breakdownPrefix + `
SELECT
    coalesce(
        nullIf(a_via_step.agent_name, ''),
        nullIf(a_direct.agent_name, ''),
        ''
    )                                       AS key,
    sum(l.cost_usd)                         AS cost,
    count()                                 AS calls,
    countIf(l.status = 'error')             AS errors
FROM llms l
LEFT JOIN steps  s          ON l.parent_span_id = s.span_id
LEFT JOIN agents a_via_step ON s.parent_span_id = a_via_step.span_id
LEFT JOIN agents a_direct   ON l.parent_span_id = a_direct.span_id
GROUP BY key
ORDER BY cost DESC
LIMIT 20`
	if res.ByAgent, err = runBreakdown(ctx, ch, byAgentQ, args); err != nil {
		return nil, fmt.Errorf("workflow-detail by-agent: %w", err)
	}

	// ── 3. By step — 1-hop: llm.parent → step.span_id ──
	byStepQ := breakdownPrefix + `
SELECT
    coalesce(s.step_name, '')               AS key,
    sum(l.cost_usd)                         AS cost,
    count()                                 AS calls,
    countIf(l.status = 'error')             AS errors
FROM llms l
LEFT JOIN steps s ON l.parent_span_id = s.span_id
GROUP BY key
ORDER BY cost DESC
LIMIT 20`
	if res.ByStep, err = runBreakdown(ctx, ch, byStepQ, args); err != nil {
		return nil, fmt.Errorf("workflow-detail by-step: %w", err)
	}

	// ── 4. By customer — single-dim, no join ──
	byCustomerQ := breakdownPrefix + `
SELECT
    coalesce(l.customer_id, '')             AS key,
    sum(l.cost_usd)                         AS cost,
    count()                                 AS calls,
    countIf(l.status = 'error')             AS errors
FROM llms l
GROUP BY key
ORDER BY cost DESC
LIMIT 20`
	if res.ByCustomer, err = runBreakdown(ctx, ch, byCustomerQ, args); err != nil {
		return nil, fmt.Errorf("workflow-detail by-customer: %w", err)
	}

	// ── 5. By model — same shape ──
	byModelQ := breakdownPrefix + `
SELECT
    l.model                                 AS key,
    sum(l.cost_usd)                         AS cost,
    count()                                 AS calls,
    countIf(l.status = 'error')             AS errors
FROM llms l
GROUP BY key
ORDER BY cost DESC
LIMIT 20`
	if res.ByModel, err = runBreakdown(ctx, ch, byModelQ, args); err != nil {
		return nil, fmt.Errorf("workflow-detail by-model: %w", err)
	}

	// ── 6. By cost_source — input for the workflow detail page's
	//        cost-confidence strip (server_computed vs sdk_fallback vs
	//        unknown_model). Mirrors the org-wide Cost Confidence card. ──
	bySourceQ := breakdownPrefix + `
SELECT
    coalesce(l.cost_source, 'unknown')      AS key,
    sum(l.cost_usd)                         AS cost,
    count()                                 AS calls,
    countIf(l.status = 'error')             AS errors
FROM llms l
GROUP BY key
ORDER BY cost DESC
LIMIT 20`
	if res.CostSourceMix, err = runBreakdown(ctx, ch, bySourceQ, args); err != nil {
		return nil, fmt.Errorf("workflow-detail by-cost-source: %w", err)
	}

	return res, nil
}

// runBreakdown executes a (key, cost, calls, errors) query and scans into
// WorkflowBreakdownRow. Factored out because every breakdown panel uses the
// same row shape — DRY beats inlining four identical scan loops.
func runBreakdown(ctx context.Context, ch driver.Conn, q string, args []any) ([]WorkflowBreakdownRow, error) {
	rows, err := ch.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck
	out := make([]WorkflowBreakdownRow, 0, 20)
	for rows.Next() {
		var r WorkflowBreakdownRow
		if err := rows.Scan(&r.Key, &r.CostUSD, &r.Calls, &r.ErrorCount); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
