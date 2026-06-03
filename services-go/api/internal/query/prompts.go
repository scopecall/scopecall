package query

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// PromptRow is one prompt version's aggregated metrics over the time window.
// Used by the Prompts page to surface KPI deltas across prompt iterations:
// "we shipped v3 last Tuesday — did cost / latency / error rate move?".
//
// Untagged calls (prompt_version IS NULL) are grouped into a single row with
// the empty-string key so users can drill into "what fraction of calls aren't
// tagged yet?". The frontend renders that bucket as "(untagged)".
type PromptRow struct {
	Version       string
	Calls         uint64
	TotalCostUSD  float64
	AvgCostPerCall float64
	// p50 / p95 latency in ms. quantileExact is used (not quantile) so the
	// numbers are reproducible — the dashboard table is the kind of place
	// where a user re-runs a query and expects the same value to come back.
	P50LatencyMS  float64
	P95LatencyMS  float64
	AvgInputTokens  float64
	AvgOutputTokens float64
	ErrorCount    uint64
	ErrorRate     float64 // 0..1
	FirstSeen     time.Time
	LastSeen      time.Time
}

const (
	defaultPromptsLimit = 200
	maxPromptsLimit     = 1000
)

// ListPrompts aggregates llm_calls grouped by prompt_version. Optional
// feature_name and environment filters narrow the window before grouping,
// matching the precedence the dashboard's filter chips set.
func ListPrompts(
	ctx context.Context,
	ch driver.Conn,
	orgID string,
	tw TimeWindow,
	featureName, environment string,
	limit int,
) ([]PromptRow, error) {
	if limit <= 0 {
		limit = defaultPromptsLimit
	}
	if limit > maxPromptsLimit {
		limit = maxPromptsLimit
	}

	conds := []string{}
	queryArgs := []any{
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	}
	if featureName != "" {
		conds = append(conds, "feature_name = {feature_name:String}")
		queryArgs = append(queryArgs, driver.NamedValue{Name: "feature_name", Value: featureName})
	}
	if environment != "" {
		conds = append(conds, "environment = {environment:String}")
		queryArgs = append(queryArgs, driver.NamedValue{Name: "environment", Value: environment})
	}
	whereExtra := "1=1"
	if len(conds) > 0 {
		whereExtra = ""
		for i, c := range conds {
			if i > 0 { whereExtra += " AND " }
			whereExtra += c
		}
	}

	// coalesce to '' so NULL collapses into one bucket — same approach as the
	// sessions query handles missing session_id. The empty-string key is
	// preserved through to the frontend which renders it as "(untagged)".
	//
	// We deliberately do NOT use FINAL: the cost is high, and ReplacingMergeTree
	// dedupes by (org_id, timestamp, span_id) so duplicates from at-least-once
	// delivery would only show up as a transient inflation of call counts that
	// resolves at the next merge. The Prompts page is "approximate good enough"
	// territory, not transactional reporting.
	q := fmt.Sprintf(`
SELECT
    coalesce(prompt_version, '')             AS version,
    count()                                  AS calls,
    sum(cost_usd)                            AS cost,
    avg(cost_usd)                            AS avg_cost,
    -- toFloat64: quantileExact returns the input column's type (UInt32 here).
    -- Scanning a UInt32 into a Go float64 panics the clickhouse-go driver
    -- with a 500 — caught by E2E test. The cast keeps the column type
    -- consistent with the Go PromptRow.P50LatencyMS / P95LatencyMS fields.
    toFloat64(quantileExact(0.5)(latency_ms))  AS p50,
    toFloat64(quantileExact(0.95)(latency_ms)) AS p95,
    avg(input_tokens)                        AS avg_in,
    avg(output_tokens)                       AS avg_out,
    countIf(status != 'success')             AS errs,
    countIf(status != 'success') / count()   AS error_rate,
    min(timestamp)                           AS first_seen,
    max(timestamp)                           AS last_seen
FROM llm_calls
-- kind = 'llm' is critical here. Without it, workflow rows (zero
-- input/output_tokens, zero cost) skew avg_input_tokens / avg_output_tokens
-- DOWN and inflate call counts. Per-prompt analytics need provider-call
-- rows only. See overview.go for the broader rationale.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
  AND %s
GROUP BY version
ORDER BY cost DESC, calls DESC
LIMIT %d
`, whereExtra, limit)

	rows, err := ch.Query(ctx, q, queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("prompts query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]PromptRow, 0, 32)
	for rows.Next() {
		var p PromptRow
		if err := rows.Scan(
			&p.Version, &p.Calls, &p.TotalCostUSD, &p.AvgCostPerCall,
			&p.P50LatencyMS, &p.P95LatencyMS,
			&p.AvgInputTokens, &p.AvgOutputTokens,
			&p.ErrorCount, &p.ErrorRate,
			&p.FirstSeen, &p.LastSeen,
		); err != nil {
			return nil, fmt.Errorf("scan prompt row: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
