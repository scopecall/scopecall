package query

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// WasteItem is one actionable "you're burning money here" finding for the
// Waste Inbox on Overview. Surfacing rules are intentionally deterministic
// (not ML-derived) — at v0.3 we want users to be able to reason about why
// each item showed up. Each item carries enough structure for the frontend to
// render a recommendation + a drill-in link without re-querying.
//
// Severity tiers:
//   high   — single-item potential savings > 1% of org's total spend in window
//   medium — > 0.1% of total spend
//   low    — anything else that still beat the floor
//
// PotentialSavingsUSD is a deliberately conservative estimate: we model the
// savings of "fix this and you stop paying this cost going forward" by
// reporting the wasted-cost-in-the-window directly. Compounded daily-rate
// projection is left for the user's mental math — overpromising savings
// burns trust the first time the user does the back-of-envelope and finds we
// were optimistic.
type WasteItem struct {
	Kind                string
	Severity            string
	Headline            string
	Detail              string
	Recommendation      string
	PotentialSavingsUSD float64
	// Optional structured evidence so the frontend can render badges/links
	// without parsing Headline strings.
	Workflow string
	Model    string
	Step     string
}

// WasteInbox enumerates concrete waste signals in the (orgID, window) tuple
// and returns them ranked by PotentialSavingsUSD desc. The function runs three
// independent CH queries — one per rule — and merges the results. Each rule
// is bounded (top N per rule) so a pathological tenant can't blow up the
// response.
func WasteInbox(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow) ([]WasteItem, error) {
	// Total spend in the window — used for severity thresholding so a $10K
	// org and a $10 org both see useful items. Computed once, passed to each
	// rule. Falls back to 0 (no severity-tier amplification) on error.
	var grand float64
	{
		row := ch.QueryRow(ctx, `
SELECT sum(cost_usd)
FROM llm_calls
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}`,
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		)
		_ = row.Scan(&grand)
	}

	var items []WasteItem

	// ── Rule 1: Retry burners ──────────────────────────────────────────────
	// Group by (workflow_feature, model). Surface cells where retry_cost is
	// non-trivial AND retry_pct > 10% — anything below that is statistical
	// noise from one-off rate-limits. We attribute to workflow via trace_id
	// join (same as the treemap) so the "workflow" column is the user's
	// logical workflow name, not the step or LLM feature_name.
	{
		q := `
WITH workflow_map AS (
    SELECT trace_id, argMin(coalesce(nullIf(feature_name, ''), ''), timestamp) AS wf
    FROM llm_calls
    WHERE org_id = {org_id:String} AND kind = 'workflow'
      AND timestamp >= {from:DateTime('UTC')} AND timestamp < {to:DateTime('UTC')}
    GROUP BY trace_id
)
SELECT
    coalesce(wm.wf, '')                                                 AS workflow,
    l.model                                                             AS model,
    sumIf(l.cost_usd, l.attempt_number > 1)                             AS retry_cost,
    sum(l.cost_usd)                                                     AS total_cost,
    countIf(l.attempt_number > 1)                                       AS retry_calls,
    count()                                                             AS total_calls
FROM llm_calls l
LEFT JOIN workflow_map wm ON l.trace_id = wm.trace_id
WHERE l.org_id = {org_id:String}
  AND l.kind   = 'llm'
  AND l.timestamp >= {from:DateTime('UTC')} AND l.timestamp < {to:DateTime('UTC')}
GROUP BY workflow, model
HAVING retry_cost > 0.001 AND total_cost > 0
   AND retry_cost / total_cost > 0.10
ORDER BY retry_cost DESC
LIMIT 5`
		rows, err := ch.Query(ctx, q,
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		)
		if err != nil {
			return nil, fmt.Errorf("waste-inbox retries: %w", err)
		}
		for rows.Next() {
			var wf, model string
			var retryCost, totalCost float64
			var retryCalls, totalCalls uint64
			if err := rows.Scan(&wf, &model, &retryCost, &totalCost, &retryCalls, &totalCalls); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan waste-inbox retries: %w", err)
			}
			retryPct := retryCost / totalCost * 100
			wfLabel := wf
			if wfLabel == "" {
				wfLabel = "(unattributed)"
			}
			items = append(items, WasteItem{
				Kind:                "retry_burner",
				Severity:            severity(retryCost, grand),
				Headline:            fmt.Sprintf("%s × %s is wasting %.0f%% on retries", wfLabel, model, retryPct),
				Detail:              fmt.Sprintf("%d/%d calls retried — cost spent on duplicate work that didn't change the outcome.", retryCalls, totalCalls),
				Recommendation:      "Inspect the retry_reason on these calls. If rate_limit dominates, batch or back off; if server_error, the prompt may be triggering provider validation.",
				PotentialSavingsUSD: retryCost,
				Workflow:            wf,
				Model:               model,
			})
		}
		_ = rows.Close()
	}

	// ── Rule 2: Premium model on a cheap-step ───────────────────────────────
	// For each step (feature_name on kind='step' rows), find whether the step
	// uses both a cheap and an expensive model. If the expensive model's
	// per-call cost is > 3× the cheapest one used on the same step, AND the
	// expensive variant has > 5 calls, AND the dollar gap is meaningful, the
	// step is "model misuse" — the cheap model already works, the expensive
	// one is doing the same job at multiple-times the cost.
	//
	// The 3× threshold is conservative: real model gaps between gpt-4o-mini
	// and claude-opus are ~50×, but we want to surface things like
	// "haiku → sonnet on a step where haiku worked fine" too.
	{
		q := `
WITH step_map AS (
    SELECT span_id, coalesce(nullIf(feature_name, ''), '') AS step_name
    FROM llm_calls
    WHERE org_id = {org_id:String} AND kind = 'step'
      AND timestamp >= {from:DateTime('UTC')} AND timestamp < {to:DateTime('UTC')}
),
per_step_model AS (
    SELECT
        s.step_name                                  AS step_name,
        l.model                                      AS model,
        count()                                      AS calls,
        sum(l.cost_usd)                              AS total_cost,
        avg(l.cost_usd)                              AS avg_cost
    FROM llm_calls l
    INNER JOIN step_map s ON l.parent_span_id = s.span_id
    WHERE l.org_id = {org_id:String}
      AND l.kind   = 'llm'
      AND l.cost_usd > 0
      AND l.timestamp >= {from:DateTime('UTC')} AND l.timestamp < {to:DateTime('UTC')}
    GROUP BY step_name, model
    HAVING calls >= 2
),
step_cheapest AS (
    SELECT step_name, min(avg_cost) AS cheap_avg
    FROM per_step_model
    GROUP BY step_name
    HAVING count() > 1
)
SELECT
    psm.step_name                                    AS step_name,
    psm.model                                        AS expensive_model,
    psm.calls                                        AS expensive_calls,
    psm.total_cost                                   AS expensive_total,
    psm.avg_cost                                     AS expensive_avg,
    sc.cheap_avg                                     AS cheap_avg,
    (psm.avg_cost - sc.cheap_avg) * psm.calls        AS potential_savings
FROM per_step_model psm
INNER JOIN step_cheapest sc ON psm.step_name = sc.step_name
WHERE psm.avg_cost > sc.cheap_avg * 3
  AND psm.calls >= 5
  AND (psm.avg_cost - sc.cheap_avg) * psm.calls > 0.005
ORDER BY potential_savings DESC
LIMIT 5`
		rows, err := ch.Query(ctx, q,
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		)
		if err != nil {
			return nil, fmt.Errorf("waste-inbox model-misuse: %w", err)
		}
		for rows.Next() {
			var stepName, expModel string
			var expCalls uint64
			var expTotal, expAvg, cheapAvg, savings float64
			if err := rows.Scan(&stepName, &expModel, &expCalls, &expTotal, &expAvg, &cheapAvg, &savings); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan waste-inbox model-misuse: %w", err)
			}
			stepLabel := stepName
			if stepLabel == "" {
				stepLabel = "(unnamed step)"
			}
			// Defensive: the CTE filters cost_usd > 0 so cheapAvg should never
			// be 0 in practice. But if a future refactor lets unknown_model
			// rows (priced at $0) into per_step_model, cheapAvg could be 0
			// and we'd format "+Inf×" into the headline. Skip + log
			// rather than emit nonsense.
			if cheapAvg <= 0 {
				continue
			}
			multiplier := expAvg / cheapAvg
			items = append(items, WasteItem{
				Kind:                "model_misuse",
				Severity:            severity(savings, grand),
				Headline:            fmt.Sprintf("%s is using %s at %.0f× the cost of cheaper alternatives", stepLabel, expModel, multiplier),
				Detail:              fmt.Sprintf("Same step is also served by a model averaging $%.5f/call vs $%.5f/call on %s, across %d calls.", cheapAvg, expAvg, expModel, expCalls),
				Recommendation:      "If quality is comparable, switch this step to the cheaper model. Otherwise, A/B test before/after with a prompt-version bump to capture quality delta.",
				PotentialSavingsUSD: savings,
				Step:                stepName,
				Model:               expModel,
			})
		}
		_ = rows.Close()
	}

	// ── Rule 3: High-error workflows ───────────────────────────────────────
	// Workflows where the error rate exceeds 5% AND the cost on errored
	// calls is non-trivial. Errored calls are pure waste: the user paid the
	// provider for tokens but got no usable output.
	{
		q := `
WITH workflow_map AS (
    SELECT trace_id, argMin(coalesce(nullIf(feature_name, ''), ''), timestamp) AS wf
    FROM llm_calls
    WHERE org_id = {org_id:String} AND kind = 'workflow'
      AND timestamp >= {from:DateTime('UTC')} AND timestamp < {to:DateTime('UTC')}
    GROUP BY trace_id
)
SELECT
    coalesce(wm.wf, '')                              AS workflow,
    countIf(l.status = 'error')                      AS error_calls,
    count()                                          AS total_calls,
    sumIf(l.cost_usd, l.status = 'error')            AS error_cost
FROM llm_calls l
LEFT JOIN workflow_map wm ON l.trace_id = wm.trace_id
WHERE l.org_id = {org_id:String}
  AND l.kind   = 'llm'
  AND l.timestamp >= {from:DateTime('UTC')} AND l.timestamp < {to:DateTime('UTC')}
GROUP BY workflow
HAVING total_calls >= 10
   AND error_calls / total_calls > 0.05
   AND error_cost > 0.001
ORDER BY error_cost DESC
LIMIT 5`
		rows, err := ch.Query(ctx, q,
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		)
		if err != nil {
			return nil, fmt.Errorf("waste-inbox errors: %w", err)
		}
		for rows.Next() {
			var wf string
			var errCalls, totalCalls uint64
			var errCost float64
			if err := rows.Scan(&wf, &errCalls, &totalCalls, &errCost); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan waste-inbox errors: %w", err)
			}
			wfLabel := wf
			if wfLabel == "" {
				wfLabel = "(unattributed)"
			}
			rate := float64(errCalls) / float64(totalCalls) * 100
			items = append(items, WasteItem{
				Kind:                "high_error_workflow",
				Severity:            severity(errCost, grand),
				Headline:            fmt.Sprintf("%s has a %.0f%% error rate — %d/%d calls", wfLabel, rate, errCalls, totalCalls),
				Detail:              "Errored calls still cost money — provider charges for tokens even when the response is unusable.",
				Recommendation:      "Filter Traces to this workflow + status=error, inspect error_message to find the prompt/payload triggering it.",
				PotentialSavingsUSD: errCost,
				Workflow:            wf,
			})
		}
		_ = rows.Close()
	}

	// Rank by potential savings desc — most actionable at the top.
	// Stable sort is fine: ties keep insertion order (retry > model > error)
	// which is also a reasonable priority.
	sortByPotentialSavingsDesc(items)
	return items, nil
}

func severity(savings, grand float64) string {
	if grand <= 0 {
		return "medium"
	}
	share := savings / grand
	switch {
	case share > 0.01:
		return "high"
	case share > 0.001:
		return "medium"
	default:
		return "low"
	}
}

func sortByPotentialSavingsDesc(items []WasteItem) {
	// Insertion sort — items is bounded to ≤15 (3 rules × 5 cap each), so
	// O(n²) is fine and we avoid an `import "sort"` round-trip.
	for i := 1; i < len(items); i++ {
		j := i
		for j > 0 && items[j].PotentialSavingsUSD > items[j-1].PotentialSavingsUSD {
			items[j], items[j-1] = items[j-1], items[j]
			j--
		}
	}
}
