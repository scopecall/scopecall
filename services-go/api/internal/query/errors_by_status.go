package query

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// ErrorBucket is one bucketed slice of failures broken out by status. We
// deliberately drop "success" — this endpoint feeds the stacked-failure chart,
// not volume. The bucket size is determined by `granularity` ("hour" or "day").
type ErrorBucket struct {
	Hour        time.Time
	Error       uint64
	Timeout     uint64
	RateLimited uint64
}

// ErrorsByStatus returns per-bucket counts of error / timeout / rate_limited
// across the window. Reads raw llm_calls because the hourly rollup carries a
// single error_count column (it lumps all failure types together).
func ErrorsByStatus(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, granularity string) ([]ErrorBucket, error) {
	bucketExpr := "toStartOfHour(timestamp)"
	if granularity == "day" {
		bucketExpr = "toStartOfDay(timestamp)"
	}

	q := fmt.Sprintf(`
SELECT
    %s                                AS bucket,
    countIf(status = 'error')         AS errs,
    countIf(status = 'timeout')       AS timeouts,
    countIf(status = 'rate_limited')  AS rls
FROM llm_calls
-- kind='llm' — LLM error chart counts provider-call failures only. A
-- workflow row's status='error' means the trace BLOCK threw, which is a
-- separate signal we may surface as a "workflow failure" chart later.
-- See overview.go for the broader rationale.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
GROUP BY bucket
ORDER BY bucket ASC
`, bucketExpr)

	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, fmt.Errorf("errors-by-status query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]ErrorBucket, 0, 24)
	for rows.Next() {
		var b ErrorBucket
		if err := rows.Scan(&b.Hour, &b.Error, &b.Timeout, &b.RateLimited); err != nil {
			return nil, fmt.Errorf("scan error bucket: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
