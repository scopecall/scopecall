package query

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type MetricPoint struct {
	Hour         time.Time
	Model        string
	CallCount    uint64
	TotalCostUSD float64
	AvgLatencyMS float64
	P99LatencyMS float64
	ErrorCount   uint64
}

// Granularity is "hour" (default) or "day". Day groups the per-hour rollup
// rows up via toStartOfDay; avgMerge/quantileMerge across hourly aggregate
// states is mathematically correct (the states are designed to compose).
func Metrics(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, granularity string, scope Scope) ([]MetricPoint, error) {
	// Default to hourly; only "day" switches behaviour.
	bucketExpr := "hour"
	if granularity == "day" {
		bucketExpr = "toStartOfDay(hour)"
	}

	q := fmt.Sprintf(`
SELECT
    %s                                  AS bucket,
    model,
    sum(call_count)                     AS call_count,
    sum(total_cost_usd)                 AS total_cost_usd,
    avgMerge(avg_latency_ms)            AS avg_latency_ms,
    quantileMerge(0.99)(p99_latency_ms) AS p99_latency_ms,
    sum(error_count)                    AS error_count
FROM llm_metrics_hourly
WHERE org_id = {org_id:String}
  AND hour >= {from:DateTime('UTC')}
  AND hour <  {to:DateTime('UTC')}
GROUP BY bucket, model
ORDER BY bucket ASC, model ASC
-- Hard cap on output rows. Misbehaving SDK that sets model to a per-request
-- UUID would otherwise return (buckets × N-unique-models) rows — potentially
-- MBs of JSON. 50K rows = 24h × 720 hourly buckets × ~3 models headroom.
LIMIT 50000
`, bucketExpr)

	// The hourly rollup doesn't carry environment/project, so a scoped
	// request falls back to a raw llm_calls scan — same precedent as
	// breakdown's environment group-by. Slower but correct; scoped views
	// are interactive drill-ins, not the default org-wide dashboard load.
	if scope != (Scope{}) {
		rawBucket := "toStartOfHour(timestamp)"
		if granularity == "day" {
			rawBucket = "toStartOfDay(timestamp)"
		}
		q = fmt.Sprintf(`
SELECT
    %s                                  AS bucket,
    model,
    count()                             AS call_count,
    sum(cost_usd)                       AS total_cost_usd,
    ifNotFinite(avg(latency_ms), 0)     AS avg_latency_ms,
    ifNotFinite(quantile(0.99)(latency_ms), 0) AS p99_latency_ms,
    countIf(status = 'error')           AS error_count
FROM llm_calls
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}%s
GROUP BY bucket, model
ORDER BY bucket ASC, model ASC
LIMIT 50000
`, rawBucket, scope.cond(""))
	}

	args := scope.params([]driver.NamedValue{
		{Name: "org_id", Value: orgID},
		{Name: "from", Value: chDateTime(tw.From)},
		{Name: "to", Value: chDateTime(tw.To)},
	})
	rows, err := ch.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("metrics query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var pts []MetricPoint
	for rows.Next() {
		var p MetricPoint
		if err := rows.Scan(
			&p.Hour, &p.Model,
			&p.CallCount, &p.TotalCostUSD,
			&p.AvgLatencyMS, &p.P99LatencyMS,
			&p.ErrorCount,
		); err != nil {
			return nil, fmt.Errorf("scan metric point: %w", err)
		}
		pts = append(pts, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("metrics rows: %w", err)
	}
	return pts, nil
}
