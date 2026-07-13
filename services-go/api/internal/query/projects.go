package query

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// Projects lists the distinct non-empty project labels the org has ever
// emitted, alphabetically. Powers the dashboard's project picker.
//
// Deliberately NOT windowed: a project that was quiet for the selected range
// should still be selectable (its scoped view then legitimately shows zero
// activity). The '' (unassigned) bucket is excluded — the picker's "All
// projects" already covers it, and offering it as a filter would need
// IS-empty semantics the Scope type doesn't model.
//
// LIMIT 100 is a sanity cap: project is a config-set label, so more than a
// handful of values means an SDK is misconfigured (e.g. a per-run UUID);
// truncating protects the picker instead of rendering thousands of entries.
func Projects(ctx context.Context, ch driver.Conn, orgID string) ([]string, error) {
	const q = `
SELECT DISTINCT project
FROM llm_calls
WHERE org_id = {org_id:String}
  AND project != ''
ORDER BY project ASC
LIMIT 100`
	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
	)
	if err != nil {
		return nil, fmt.Errorf("projects query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]string, 0, 8)
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("projects rows: %w", err)
	}
	return out, nil
}
