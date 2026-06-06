package query

import (
	"context"
	"fmt"
	"sort"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// RegressionKind classifies what got worse. The frontend reads this to pick
// an icon/copy; the ranking logic uses it to compute severity.
type RegressionKind string

const (
	RegressionLatencyP99 RegressionKind = "latency_p99"
	RegressionErrorRate  RegressionKind = "error_rate"
	RegressionCost       RegressionKind = "cost"
	RegressionVolumeDrop RegressionKind = "volume_drop"
)

// Severity controls visual treatment. Critical = red border; watch = amber.
type RegressionSeverity string

const (
	SeverityCritical RegressionSeverity = "critical"
	SeverityWatch    RegressionSeverity = "watch"
)

// Regression is one auto-detected "X just got worse" signal. The dim/key
// pair identifies what regressed; current/prior values let the UI show a
// before/after comparison.
type Regression struct {
	Kind         RegressionKind     `json:"kind"`
	Severity     RegressionSeverity `json:"severity"`
	Feature      string             `json:"feature"`
	Model        string             `json:"model"`
	CurrentValue float64            `json:"current_value"`
	PriorValue   float64            `json:"prior_value"`
	PctChange    float64            `json:"pct_change"` // signed; negative for drops
	CurrentCalls uint64             `json:"current_calls"`
}

// aggregate is the per-(feature, model) snapshot used for both periods.
type aggregate struct {
	feature   string
	model     string
	calls     uint64
	cost      float64
	avgLat    float64
	p99Lat    float64
	errors    uint64
	errorRate float64
}

// Detection thresholds. Tuned conservatively — when the panel shows nothing
// most days, users trust the few signals it does surface. If we get a flood
// of low-signal noise, tighten further.
const (
	minCallsForDetection = 50

	p99PctThreshold      = 50.0  // % relative jump
	p99MinCurrentMS      = 500.0 // floor — don't flag 10ms→16ms
	p99MinPriorMS        = 100.0 // need a meaningful baseline
	p99CriticalPctChange = 100.0 // doubled = critical

	errorRateAbsThreshold    = 2.0 // percentage points jump
	errorRateMinCurrentPct   = 2.0 // current must be elevated
	errorRateCriticalCurrent = 5.0 // current ≥5% always critical

	costPctThreshold      = 30.0 // % relative
	costMinCurrentUSD     = 1.0
	costMinDeltaUSD       = 1.0
	costCriticalPctChange = 100.0 // doubled cost = critical

	volumeDropPctThreshold  = 50.0 // -50% or worse
	volumeDropMinPriorCalls = 200  // need to have BEEN active before flagging
)

// Regressions detects metric-level regressions between the current window
// and an equal-length window immediately prior. Returns at most `limit`
// items, sorted by severity then magnitude.
//
// Implementation: two breakdown queries (current + prior), joined + diffed
// in Go. Could be a single CTE-heavy SQL but readability + ability to log
// individual stage results outweighs the extra round-trip — neither query
// is expensive in ClickHouse.
func Regressions(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, priorTW TimeWindow, limit int) ([]Regression, error) {
	if limit <= 0 {
		limit = 5
	}
	if limit > 20 {
		limit = 20
	}

	curr, err := loadAggregates(ctx, ch, orgID, tw)
	if err != nil {
		return nil, fmt.Errorf("regressions current: %w", err)
	}
	prior, err := loadAggregates(ctx, ch, orgID, priorTW)
	if err != nil {
		return nil, fmt.Errorf("regressions prior: %w", err)
	}
	priorIdx := make(map[string]aggregate, len(prior))
	for _, p := range prior {
		priorIdx[p.feature+"|"+p.model] = p
	}

	var out []Regression
	for _, c := range curr {
		p, ok := priorIdx[c.feature+"|"+c.model]
		if !ok {
			continue // brand-new dim — not a regression, "new model" is handled by insights strip
		}

		if r := detectP99Regression(c, p); r != nil {
			out = append(out, *r)
		}
		if r := detectErrorRateRegression(c, p); r != nil {
			out = append(out, *r)
		}
		if r := detectCostRegression(c, p); r != nil {
			out = append(out, *r)
		}
		if r := detectVolumeDrop(c, p); r != nil {
			out = append(out, *r)
		}
	}

	// Sort: critical first, then magnitude of change.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Severity != out[j].Severity {
			return out[i].Severity == SeverityCritical
		}
		// Use absolute pct change as the magnitude proxy.
		absI, absJ := out[i].PctChange, out[j].PctChange
		if absI < 0 {
			absI = -absI
		}
		if absJ < 0 {
			absJ = -absJ
		}
		return absI > absJ
	})

	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func loadAggregates(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow) ([]aggregate, error) {
	q := `
SELECT
    coalesce(nullIf(feature_name, ''), '')              AS feature,
    model,
    count()                                             AS calls,
    sum(cost_usd)                                       AS cost,
    avg(latency_ms)                                     AS avg_lat,
    toFloat64(quantileExact(0.99)(latency_ms))          AS p99_lat,
    toUInt64(countIf(status = 'error'))                 AS errors,
    ifNotFinite(countIf(status = 'error') / count() * 100, 0) AS err_rate_pct
FROM llm_calls
-- kind='llm' — regression detection runs against provider-call rows only.
-- See overview.go.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
GROUP BY feature, model
-- Cap output rows. We only surface the top N regressions to users; aggregating
-- across 10K dimension values is wasted work AND a memory hazard.
LIMIT 10000`

	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck

	var out []aggregate
	for rows.Next() {
		var a aggregate
		if err := rows.Scan(&a.feature, &a.model, &a.calls, &a.cost, &a.avgLat, &a.p99Lat, &a.errors, &a.errorRate); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ────────────────────────────────────────────────────────────────────────────
// Detection rules — pure functions, one per regression kind.
//
// Each returns either a populated *Regression or nil. Extracting these out of
// the main loop makes them table-testable without touching ClickHouse, which
// is the only sane way to verify the conservative threshold logic doesn't
// drift over time.
//
// All thresholds live in the package-level consts at the top of this file.
// ────────────────────────────────────────────────────────────────────────────

// makeRegression is a tiny constructor so each detector reads top-down.
func makeRegression(kind RegressionKind, sev RegressionSeverity, c, p aggregate, currentValue, priorValue, pctChange float64) *Regression {
	return &Regression{
		Kind: kind, Severity: sev,
		Feature: c.feature, Model: c.model,
		CurrentValue: currentValue, PriorValue: priorValue, PctChange: pctChange,
		CurrentCalls: c.calls,
	}
}

func detectP99Regression(c, p aggregate) *Regression {
	if c.calls < minCallsForDetection {
		return nil
	}
	if c.p99Lat < p99MinCurrentMS || p.p99Lat < p99MinPriorMS {
		// Floor: don't flag 10ms→16ms as a "p99 regression" — that's noise.
		return nil
	}
	pct := ((c.p99Lat - p.p99Lat) / p.p99Lat) * 100
	if pct < p99PctThreshold {
		return nil
	}
	sev := SeverityWatch
	if pct >= p99CriticalPctChange {
		sev = SeverityCritical
	}
	return makeRegression(RegressionLatencyP99, sev, c, p, c.p99Lat, p.p99Lat, pct)
}

func detectErrorRateRegression(c, p aggregate) *Regression {
	// Absolute percentage-point delta — relative changes on small base rates
	// are misleading (0.1% → 0.3% is "+200%" but barely matters).
	if c.calls < minCallsForDetection {
		return nil
	}
	if c.errorRate < errorRateMinCurrentPct {
		return nil
	}
	diff := c.errorRate - p.errorRate
	if diff < errorRateAbsThreshold {
		return nil
	}
	sev := SeverityWatch
	if c.errorRate >= errorRateCriticalCurrent {
		sev = SeverityCritical
	}
	return makeRegression(RegressionErrorRate, sev, c, p, c.errorRate, p.errorRate, diff)
}

func detectCostRegression(c, p aggregate) *Regression {
	if c.cost < costMinCurrentUSD || p.cost <= 0 {
		return nil
	}
	delta := c.cost - p.cost
	pct := (delta / p.cost) * 100
	if pct < costPctThreshold || delta < costMinDeltaUSD {
		return nil
	}
	sev := SeverityWatch
	if pct >= costCriticalPctChange {
		sev = SeverityCritical
	}
	return makeRegression(RegressionCost, sev, c, p, c.cost, p.cost, pct)
}

func detectVolumeDrop(c, p aggregate) *Regression {
	// "It disappeared" is often a regression — broken flow, deploy bug — even
	// when nothing else looks wrong. Only flag when the dim WAS active before
	// (otherwise we'd label every quiet-day baseline as a "drop").
	if p.calls < volumeDropMinPriorCalls || c.calls >= p.calls {
		return nil
	}
	pct := ((float64(c.calls) - float64(p.calls)) / float64(p.calls)) * 100
	if pct > -volumeDropPctThreshold {
		return nil
	}
	return makeRegression(RegressionVolumeDrop, SeverityWatch, c, p, float64(c.calls), float64(p.calls), pct)
}
