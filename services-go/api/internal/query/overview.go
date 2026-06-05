package query

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type OverviewResult struct {
	TotalCalls   uint64
	TotalCostUSD float64
	// ErrorCostUSD is the subset of TotalCostUSD attributable to non-success
	// calls (typically mid-stream provider failures where input tokens were
	// processed before the connection died). Almost always 0 for clients
	// using the auto-instrumentation, which emits input_tokens=0 on pre-flight
	// failures (4xx/429/5xx/connect-timeout).
	ErrorCostUSD float64
	AvgLatencyMS float64
	P99LatencyMS float64
	ErrorRatePct float64
	UniqueTraces uint64
}

func Overview(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow) (*OverviewResult, error) {
	const q = `
SELECT
    count()                                                      AS total_calls,
    sum(cost_usd)                                                AS total_cost_usd,
    sumIf(cost_usd, status != 'success')                         AS error_cost_usd,
    ifNotFinite(avg(latency_ms), 0)                              AS avg_latency_ms,
    ifNotFinite(quantile(0.99)(latency_ms), 0)                   AS p99_latency_ms,
    ifNotFinite(countIf(status = 'error') / count() * 100, 0)    AS error_rate_pct,
    uniqExact(trace_id)                                          AS unique_traces
FROM llm_calls
-- kind = 'llm' is mandatory on every LLM-metric query (Round-4 review).
-- The llm_calls table also stores 'workflow' rows from sdk.trace() blocks;
-- counting them here would inflate total_calls by N+1 per workflow,
-- distort latency averages with whole-block durations, and add bogus
-- error rows when the trace block threw. Trace-tree / flow-graph queries
-- intentionally DON'T filter (they need the workflow rows to JOIN).
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
`
	row := ch.QueryRow(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)

	var r OverviewResult
	if err := row.Scan(
		&r.TotalCalls,
		&r.TotalCostUSD,
		&r.ErrorCostUSD,
		&r.AvgLatencyMS,
		&r.P99LatencyMS,
		&r.ErrorRatePct,
		&r.UniqueTraces,
	); err != nil {
		return nil, fmt.Errorf("overview query: %w", err)
	}
	return &r, nil
}
