package query

import (
	"context"
	"fmt"
	"strconv"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// CostSourceShare is one row of the stacked cost-confidence breakdown.
// `Source` is one of: "server_computed" | "sdk_fallback" | "unknown_model" |
// "container" — see writer.rs LlmCallRow.cost_source for the closed enum.
type CostSourceShare struct {
	Source  string
	Calls   uint64
	CostUSD float64
}

// UnknownModelRow surfaces a model the pricing table didn't recognize. The
// frontend renders these as a punch list so the user knows exactly which
// models to add to schemas/pricing/pricing.json to get accurate numbers.
type UnknownModelRow struct {
	Model    string
	Provider string
	Calls    uint64
	CostUSD  float64 // SDK-supplied fallback cost (almost always 0 — that's the point)
}

// CostConfidenceResult aggregates the two halves of the "how much can I trust
// these dollar numbers?" indicator: the source breakdown (stacked bar input)
// and the unknown-model leaderboard (the actionable fix list).
type CostConfidenceResult struct {
	Sources           []CostSourceShare
	UnknownModels     []UnknownModelRow
	TotalCostUSD      float64
	ServerComputedUSD float64 // duplicated from Sources for fast tile rendering
}

// CostConfidence runs two queries:
//
//   - by cost_source (rows + cost): drives the stacked bar + the "X% verified"
//     headline number.
//   - top unknown models by call count: punch list for which models to add to
//     the pricing table.
//
// Both are restricted to kind='llm' so container rows (intrinsic cost_source =
// 'container') don't get conflated with real pricing-table misses.
func CostConfidence(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, unknownLimit int) (*CostConfidenceResult, error) {
	if unknownLimit <= 0 {
		unknownLimit = 10
	}
	if unknownLimit > 50 {
		unknownLimit = 50
	}

	res := &CostConfidenceResult{}

	// ── 1. By cost_source ─────────────────────────────────────────────────
	srcQ := `
SELECT
    coalesce(cost_source, 'unknown_model') AS src,
    count()                                AS calls,
    sum(cost_usd)                          AS cost
FROM llm_calls
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
GROUP BY src
ORDER BY cost DESC`
	rows, err := ch.Query(ctx, srcQ,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, fmt.Errorf("cost-confidence sources: %w", err)
	}
	for rows.Next() {
		var s CostSourceShare
		if err := rows.Scan(&s.Source, &s.Calls, &s.CostUSD); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan cost-confidence source: %w", err)
		}
		res.Sources = append(res.Sources, s)
		res.TotalCostUSD += s.CostUSD
		if s.Source == "server_computed" {
			res.ServerComputedUSD = s.CostUSD
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("cost-confidence sources rows: %w", err)
	}
	_ = rows.Close()

	// ── 2. Top unknown models ─────────────────────────────────────────────
	// Ordered by call count, not cost — for cost_source='unknown_model', the
	// stored cost_usd is usually 0 (SDK fallback wasn't provided), so cost
	// ordering would put low-volume-but-with-fallback rows above the high-
	// volume models that are silently zeroing out user spend.
	// `unknownLimit` passed as CH parameter — see workflow_cost_tree.go for
	// the rationale.
	unkQ := `
SELECT
    model                                    AS model,
    coalesce(nullIf(provider, ''), 'unknown') AS provider,
    count()                                  AS calls,
    sum(cost_usd)                            AS cost
FROM llm_calls
WHERE org_id      = {org_id:String}
  AND kind        = 'llm'
  AND cost_source = 'unknown_model'
  AND model != ''
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
GROUP BY model, provider
ORDER BY calls DESC
LIMIT {lim:UInt32}`
	unkRows, err := ch.Query(ctx, unkQ,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		// CH named params transmit as strings (see types.go).
		driver.NamedValue{Name: "lim", Value: strconv.Itoa(unknownLimit)},
	)
	if err != nil {
		return nil, fmt.Errorf("cost-confidence unknown-models: %w", err)
	}
	defer unkRows.Close() //nolint:errcheck

	for unkRows.Next() {
		var u UnknownModelRow
		if err := unkRows.Scan(&u.Model, &u.Provider, &u.Calls, &u.CostUSD); err != nil {
			return nil, fmt.Errorf("scan cost-confidence unknown-model: %w", err)
		}
		res.UnknownModels = append(res.UnknownModels, u)
	}
	return res, unkRows.Err()
}
