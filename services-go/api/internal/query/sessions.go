package query

import (
	"context"
	"fmt"
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

// ListSessions returns sessions in the window, sorted most-recent first.
// Optional userID filter scopes to a single end-user (highest-frequency
// workflow: investigating a specific customer escalation).
func ListSessions(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, userID string, limit int) ([]SessionRow, error) {
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
GROUP BY session_id
ORDER BY last_at DESC
LIMIT %d
`, userCond, limit)

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
