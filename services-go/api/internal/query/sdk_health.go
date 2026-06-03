package query

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// SDKHealthSnapshot is the "is my data actually flowing?" view. Computed from
// llm_calls, so it answers the user's first-day question — "did my SDK
// install work?" — without needing any ingest-side metrics pipeline.
//
// Schema-validation failures and ingest drop-rate aren't in here yet because
// those require a separate signal stream from the ingest service. When that
// exists, layer it on top.
type SDKHealthSnapshot struct {
	// LastCallAt is the timestamp of the most recent ingested call. Zero
	// value indicates no calls have ever arrived for this org.
	LastCallAt           time.Time `json:"last_call_at,omitempty"`
	HasCalls             bool      `json:"has_calls"`
	SecondsSinceLastCall int64     `json:"seconds_since_last_call"`

	// Activity within rolling windows. Useful for "the SDK is alive AND
	// producing the expected volume."
	CallsLastHour   uint64 `json:"calls_last_hour"`
	CallsLast24Hour uint64 `json:"calls_last_24_hour"`

	// Recent error rate (over the last hour). Distinct from the
	// period-over-period KPI deltas — this is "is the SDK itself in trouble
	// right now," not "are errors up vs. yesterday."
	RecentErrorRate float64 `json:"recent_error_rate"`

	// Diversity signals — instrumentation is properly wired when the same
	// org reports calls from multiple envs / models / SDK versions.
	DistinctEnvironments uint64   `json:"distinct_environments"`
	DistinctModels       uint64   `json:"distinct_models"`
	DistinctProviders    uint64   `json:"distinct_providers"`
	SDKVersions          []string `json:"sdk_versions"`
}

// SDKHealth produces a single-card snapshot of how the SDK is doing for an org.
// One round-trip query — cheap enough to refetch on a short cadence so the
// freshness indicator doesn't lie.
func SDKHealth(ctx context.Context, ch driver.Conn, orgID string) (*SDKHealthSnapshot, error) {
	q := `
SELECT
    max(timestamp)                                                AS last_call_at,
    countIf(timestamp >= now() - INTERVAL 1 HOUR)                 AS calls_1h,
    countIf(timestamp >= now() - INTERVAL 24 HOUR)                AS calls_24h,
    -- Error rate scoped to the last hour so transient SDK bugs jump out
    -- without being diluted by a clean 24-hour history.
    ifNotFinite(
        countIf(timestamp >= now() - INTERVAL 1 HOUR AND status = 'error')
        / countIf(timestamp >= now() - INTERVAL 1 HOUR),
        0
    )                                                             AS err_rate_1h,
    uniqExact(environment)                                        AS distinct_envs,
    uniqExact(model)                                              AS distinct_models,
    uniqExact(provider)                                           AS distinct_providers,
    arraySlice(groupUniqArray(sdk_version), 1, 5)                 AS sdk_versions
FROM llm_calls
-- kind='llm' — SDK health surfaces LLM-call statistics (distinct models,
-- providers, error rate). Workflow rows have empty model/provider and
-- would skew distinct counts down + dilute the error-rate denominator.
-- See overview.go.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  -- 7-day window for the diversity / max(timestamp) lookups so a slow week
  -- doesn't break the freshness card. Adjust if orgs commonly pause for longer.
  AND timestamp >= now() - INTERVAL 7 DAY`

	var snap SDKHealthSnapshot
	row := ch.QueryRow(ctx, q, driver.NamedValue{Name: "org_id", Value: orgID})
	if err := row.Scan(
		&snap.LastCallAt,
		&snap.CallsLastHour,
		&snap.CallsLast24Hour,
		&snap.RecentErrorRate,
		&snap.DistinctEnvironments,
		&snap.DistinctModels,
		&snap.DistinctProviders,
		&snap.SDKVersions,
	); err != nil {
		return nil, fmt.Errorf("sdk health query: %w", err)
	}

	// Derive computed fields. Doing the seconds-since math server-side keeps
	// the frontend a simple display — no time-skew bugs from client clocks.
	if !snap.LastCallAt.IsZero() {
		snap.HasCalls = true
		snap.SecondsSinceLastCall = int64(time.Since(snap.LastCallAt).Seconds())
	}
	return &snap, nil
}
