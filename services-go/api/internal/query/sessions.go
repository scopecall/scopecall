package query

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// SessionRow describes one user session (group of calls sharing session_id).
type SessionRow struct {
	SessionID    string
	UserID       string // may be empty
	CallCount    uint64
	TotalCostUSD float64
	ErrorCount   uint64
	FirstAt      time.Time
	LastAt       time.Time
}

const (
	defaultSessionsLimit = 100
	maxSessionsLimit     = 500
)

// SessionFilters narrows which sessions are returned. A session matches when
// AT LEAST ONE of its calls satisfies every set field ("match → whole session"
// semantics): the aggregates in ListSessions still span the entire session, so
// totals stay real. Empty fields are ignored; the "__null__" sentinel matches
// rows where the column IS NULL (mirrors the /traces facet "(none)" drill-in).
type SessionFilters struct {
	Model       string
	Provider    string
	Status      string
	FeatureName string
	Environment string
}

func (f SessionFilters) hasAny() bool {
	return f.Model != "" || f.Provider != "" || f.Status != "" ||
		f.FeatureName != "" || f.Environment != ""
}

// ListSessions returns sessions in the window, sorted most-recent first.
// Optional userID filter scopes to a single end-user (highest-frequency
// workflow: investigating a specific customer escalation).
func ListSessions(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, userID string, filters SessionFilters, limit int) ([]SessionRow, error) {
	if limit <= 0 {
		limit = defaultSessionsLimit
	}
	if limit > maxSessionsLimit {
		limit = maxSessionsLimit
	}

	userCond := "1=1"
	queryArgs := []any{
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	}
	if userID != "" {
		userCond = "coalesce(user_id, '') = {user_id:String}"
		queryArgs = append(queryArgs, driver.NamedValue{Name: "user_id", Value: userID})
	}

	// Cross-cutting facets (model/provider/status/feature/environment) use
	// "match → whole session" semantics: a membership subquery qualifies the
	// session (≥1 call matches), while the outer aggregates still span the
	// whole session so count()/sum() stay full-session. org_id/from/to named
	// params are reused from the outer bind — ClickHouse resolves a named
	// param wherever it appears, so each is bound only once.
	memberCond := "1=1"
	if filters.hasAny() {
		var fConds []string
		addFilter := func(col, name, val string) {
			if val == "" {
				return
			}
			if val == nullSentinel {
				fConds = append(fConds, fmt.Sprintf("%s IS NULL", col))
				return
			}
			fConds = append(fConds, fmt.Sprintf("%s = {%s:String}", col, name))
			queryArgs = append(queryArgs, driver.NamedValue{Name: name, Value: val})
		}
		addFilter("model", "f_model", filters.Model)
		addFilter("provider", "f_provider", filters.Provider)
		addFilter("status", "f_status", filters.Status)
		addFilter("feature_name", "f_feature", filters.FeatureName)
		addFilter("environment", "f_environment", filters.Environment)
		memberCond = fmt.Sprintf(`session_id IN (
    SELECT session_id
    FROM llm_calls
    WHERE org_id = {org_id:String}
      AND kind = 'llm'
      AND timestamp >= {from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}
      AND session_id IS NOT NULL
      AND %s
  )`, strings.Join(fConds, "\n      AND "))
	}

	q := fmt.Sprintf(`
SELECT
    coalesce(session_id, '')               AS session_id,
    coalesce(any(user_id), '')             AS user_id,
    count()                                AS calls,
    sum(cost_usd)                          AS cost,
    countIf(status = 'error')              AS errors,
    min(timestamp)                         AS first_at,
    max(timestamp)                         AS last_at
FROM llm_calls
-- kind = 'llm' restricts the aggregation to actual provider calls. See
-- overview.go for the workflow-row-pollution rationale.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
  AND session_id IS NOT NULL
  AND %s
  AND %s
GROUP BY session_id
ORDER BY last_at DESC
LIMIT %d
`, userCond, memberCond, limit)

	rows, err := ch.Query(ctx, q, queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("sessions query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]SessionRow, 0, 64)
	for rows.Next() {
		var s SessionRow
		if err := rows.Scan(&s.SessionID, &s.UserID, &s.CallCount, &s.TotalCostUSD, &s.ErrorCount, &s.FirstAt, &s.LastAt); err != nil {
			return nil, fmt.Errorf("scan session row: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
