package query

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/redis/go-redis/v9"
)

// Finding is one "optimization gap" surfaced on Overview. Two provenances feed
// the same shape:
//
//   - source="rule"        — a deterministic analyzer over llm_calls (the six
//     analyzers below). Fully explainable: every field is derived from SQL
//     aggregates, so a user can reason about why it fired.
//   - source="llm_insight" — a prompt-quality critique produced out-of-band by
//     the SDK's Phase-B prompt auditor and stashed in Redis by ingest. Read
//     best-effort here (see LLMInsightFindings); Redis being down never fails
//     the endpoint.
//
// Categories: caching | tokens | speed | reliability | prompt_quality.
// ImpactKind tags how ImpactValue should be read by the frontend:
// usd | tokens_pct | seconds | calls | none.
type Finding struct {
	Category       string
	Severity       string // high | medium | low
	Title          string
	Detail         string
	Recommendation string
	ImpactKind     string
	ImpactValue    float64
	Evidence       string
	Model          string // optional scope
	Feature        string // optional scope = feature_name / workflow
	Source         string // rule | llm_insight
	PromptVersion  string // optional, prompt_quality only
}

// RecommendationsResult bundles the deterministic rule findings (already ranked
// severity-then-impact) with the headline token-wastage percentage. LLM-insight
// findings are appended by the handler after these — see LLMInsightFindings.
type RecommendationsResult struct {
	// TokenWastagePct is the headline: 100 * (tokens on non-success rows +
	// output tokens on truncated rows + tokens on retry rows) / total tokens.
	TokenWastagePct float64
	Findings        []Finding
}

// truncatedFinishReasons is the set of finish_reason values that indicate the
// model was cut off before it finished — a length/token-cap stop. Providers
// disagree on the spelling (OpenAI: "length"; Anthropic-ish: "max_tokens";
// normalized Gemini: "MAX_TOKENS"; raw Gemini enum: "2"), so we match all.
const truncatedFinishReasons = "('length','max_tokens','MAX_TOKENS','2')"

// Recommendations runs the six deterministic analyzers over the (orgID, window)
// tuple and returns them ranked by severity (high>medium>low) then impact_value
// descending, plus the headline token_wastage_pct. Each analyzer is bounded
// (top-N per rule) so a pathological tenant can't blow up the response. Scope
// narrows to one environment/project exactly like Overview/WasteInbox.
func Recommendations(ctx context.Context, ch driver.Conn, orgID string, tw TimeWindow, scope Scope) (*RecommendationsResult, error) {
	res := &RecommendationsResult{}

	// Org grand spend in the window — used for usd-severity thresholding so a
	// $10K org and a $10 org both see useful items. Best-effort: on error we
	// fall through with grand=0 (severity() then returns "medium").
	var grand float64
	{
		args := scope.params([]any{
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		})
		row := ch.QueryRow(ctx, `
SELECT sum(cost_usd)
FROM llm_calls
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}`+scope.cond(""),
			args...)
		_ = row.Scan(&grand)
	}

	// ── Headline: token_wastage_pct ────────────────────────────────────────
	// Additive across three overlapping wastage buckets — a row can be both a
	// retry AND an error, and it's counted in both terms deliberately (the
	// formula is a spec, not a disjoint partition). greatest(total,1) guards
	// the divide so an empty window reports 0 rather than NaN.
	{
		args := scope.params([]any{
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		})
		row := ch.QueryRow(ctx, `
SELECT 100 * (
        sumIf(toFloat64(input_tokens + output_tokens), status != 'success')
      + sumIf(toFloat64(output_tokens),                finish_reason IN `+truncatedFinishReasons+`)
      + sumIf(toFloat64(input_tokens + output_tokens), attempt_number > 1)
    ) / greatest(toFloat64(sum(input_tokens + output_tokens)), 1) AS wastage_pct
FROM llm_calls
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}`+scope.cond(""),
			args...)
		_ = row.Scan(&res.TokenWastagePct)
	}

	// ── Analyzer 1: cache_blindspot (caching) ──────────────────────────────
	// Cache-capable models (gpt-*, ft:*, deepseek*, claude*) sending big
	// prompts (avg ≥ 1024 in-tokens) but reading back < 20% of their input
	// from cache are leaving prefix-cache discounts on the table. Impact is a
	// conservative half of the input-cost share (you can't cache 100% of every
	// prompt — the dynamic tail is always uncached).
	{
		q := `
SELECT
    model                                                       AS model,
    coalesce(nullIf(feature_name, ''), '')                      AS feature,
    toUInt64(count())                                           AS calls,
    avg(toFloat64(input_tokens))                                AS avg_input,
    toFloat64(sum(input_tokens))                                AS sum_input,
    toFloat64(sum(coalesce(cache_read_tokens, 0)))              AS sum_cache_read,
    sum(input_cost_usd)                                         AS sum_input_cost,
    sum(cost_usd)                                               AS sum_cost,
    toFloat64(sum(output_tokens))                               AS sum_output
FROM llm_calls
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
  AND (model LIKE 'gpt-%' OR model LIKE 'ft:%' OR model LIKE 'deepseek%' OR model LIKE 'claude%')` + scope.cond("") + `
GROUP BY model, feature
HAVING avg_input >= 1024
   AND sum_input > 0
   AND sum_cache_read / sum_input < 0.20
   AND sum_cost > 0.01
ORDER BY sum_cost DESC
LIMIT 5`
		args := scope.params([]any{
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		})
		rows, err := ch.Query(ctx, q, args...)
		if err != nil {
			return nil, fmt.Errorf("recommendations cache_blindspot: %w", err)
		}
		for rows.Next() {
			var model, feature string
			var calls uint64
			var avgInput, sumInput, sumCacheRead, sumInputCost, sumCost, sumOutput float64
			if err := rows.Scan(&model, &feature, &calls, &avgInput, &sumInput, &sumCacheRead, &sumInputCost, &sumCost, &sumOutput); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan cache_blindspot: %w", err)
			}
			// input_cost_share: prefer the ingest-computed input_cost_usd; fall
			// back to apportioning cost_usd by the input-token share when the
			// component cost wasn't populated (SDK-fallback pricing).
			inputCostShare := sumInputCost
			if inputCostShare <= 0 {
				if tot := sumInput + sumOutput; tot > 0 {
					inputCostShare = sumCost * (sumInput / tot)
				}
			}
			impact := 0.5 * inputCostShare
			if impact < 0.001 {
				continue // trivial recoverable dollars — not worth the row
			}
			cacheFrac := sumCacheRead / sumInput
			res.Findings = append(res.Findings, Finding{
				Category:       "caching",
				Severity:       severity(impact, grand),
				Title:          fmt.Sprintf("Prompt caching underused on %s", model),
				Detail:         fmt.Sprintf("Averaging %.0f input tokens/call but only %.0f%% of input was served from cache. Large static preambles that don't hit the prefix cache pay full input price on every call.", avgInput, cacheFrac*100),
				Recommendation: "Put the stable system/preamble first and the per-request (dynamic) content last, then enable provider prompt caching so the shared prefix is billed at the cache-read rate.",
				ImpactKind:     "usd",
				ImpactValue:    impact,
				Evidence:       fmt.Sprintf("avg %.0f in-tok/call, %.0f%% cached over %d calls, ~$%.4f input cost", avgInput, cacheFrac*100, calls, inputCostShare),
				Model:          model,
				Feature:        feature,
				Source:         "rule",
			})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("cache_blindspot rows: %w", err)
		}
		_ = rows.Close()
	}

	// ── Analyzer 2: input_bloat (tokens) ───────────────────────────────────
	// Cells whose input dwarfs their output (in/out > 8 AND input > 60% of all
	// tokens) are usually stuffing a huge context to get a small answer —
	// prime candidates for retrieval trimming or a shorter system prompt. The
	// max-cost window inside the CTE flags whether this is ALSO the org's
	// single biggest-spend cell, which bumps severity to high.
	{
		q := `
WITH cells AS (
    SELECT
        model                                        AS model,
        coalesce(nullIf(feature_name, ''), '')       AS feature,
        toUInt64(count())                            AS calls,
        toFloat64(sum(input_tokens))                 AS sum_in,
        toFloat64(sum(output_tokens))                AS sum_out,
        sum(cost_usd)                                AS cost,
        max(sum(cost_usd)) OVER ()                   AS max_cost
    FROM llm_calls
    WHERE org_id    = {org_id:String}
      AND kind      = 'llm'
      AND timestamp >= {from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}` + scope.cond("") + `
    GROUP BY model, feature
)
SELECT
    model,
    feature,
    calls,
    sum_in,
    sum_out,
    cost,
    toUInt8(cost >= max_cost AND max_cost > 0)       AS is_top_cost
FROM cells
WHERE calls  >= 10
  AND sum_in / nullIf(sum_out, 0) > 8
  AND sum_in > 0.6 * (sum_in + sum_out)
ORDER BY sum_in / nullIf(sum_in + sum_out, 0) DESC
LIMIT 5`
		args := scope.params([]any{
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		})
		rows, err := ch.Query(ctx, q, args...)
		if err != nil {
			return nil, fmt.Errorf("recommendations input_bloat: %w", err)
		}
		for rows.Next() {
			var model, feature string
			var calls uint64
			var sumIn, sumOut, cost float64
			var isTop uint8
			if err := rows.Scan(&model, &feature, &calls, &sumIn, &sumOut, &cost, &isTop); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan input_bloat: %w", err)
			}
			total := sumIn + sumOut
			if total <= 0 {
				continue
			}
			inputPct := sumIn / total * 100
			ratio := sumIn / sumOut
			sev := "medium"
			if isTop == 1 {
				sev = "high"
			}
			res.Findings = append(res.Findings, Finding{
				Category:       "tokens",
				Severity:       sev,
				Title:          fmt.Sprintf("Input-heavy calls on %s", model),
				Detail:         fmt.Sprintf("Input is %.0f× the output on this cell — a large context is being sent to produce a small answer. %.0f%% of all tokens here are input.", ratio, inputPct),
				Recommendation: "Trim the context: prune retrieved chunks, drop stale few-shot examples, or summarize history before the call. Same answer, a fraction of the input bill.",
				ImpactKind:     "tokens_pct",
				ImpactValue:    inputPct,
				Evidence:       fmt.Sprintf("%.0f%% input tokens (in:out ≈ %.0f:1) over %d calls", inputPct, ratio, calls),
				Model:          model,
				Feature:        feature,
				Source:         "rule",
			})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("input_bloat rows: %w", err)
		}
		_ = rows.Close()
	}

	// ── Analyzer 3: truncation_waste (tokens) ──────────────────────────────
	// Models cut off at their token cap (finish_reason length/max_tokens) on
	// > 5% of calls are producing partial output the caller must re-request or
	// discard — pure waste. Impact is the count of truncated calls.
	{
		q := `
SELECT
    model                                                                       AS model,
    toUInt64(count())                                                           AS calls,
    toUInt64(countIf(finish_reason IN ` + truncatedFinishReasons + `))          AS truncated
FROM llm_calls
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}` + scope.cond("") + `
GROUP BY model
HAVING calls > 0
   AND truncated / calls > 0.05
ORDER BY truncated DESC
LIMIT 5`
		args := scope.params([]any{
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		})
		rows, err := ch.Query(ctx, q, args...)
		if err != nil {
			return nil, fmt.Errorf("recommendations truncation_waste: %w", err)
		}
		for rows.Next() {
			var model string
			var calls, truncated uint64
			if err := rows.Scan(&model, &calls, &truncated); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan truncation_waste: %w", err)
			}
			rate := float64(truncated) / float64(calls)
			sev := "low"
			switch {
			case rate >= 0.20:
				sev = "high"
			case rate >= 0.10:
				sev = "medium"
			}
			res.Findings = append(res.Findings, Finding{
				Category:       "tokens",
				Severity:       sev,
				Title:          fmt.Sprintf("%s is hitting its token limit", model),
				Detail:         fmt.Sprintf("%.0f%% of calls (%d/%d) stopped at the max-token limit rather than a natural finish. Truncated output is usually re-requested at higher max_tokens or thrown away.", rate*100, truncated, calls),
				Recommendation: "Raise max_tokens for this model, or shorten the requested output (ask for structured/terse answers). If the truncation is intentional, ignore.",
				ImpactKind:     "calls",
				ImpactValue:    float64(truncated),
				Evidence:       fmt.Sprintf("%d/%d calls truncated (%.0f%%)", truncated, calls, rate*100),
				Model:          model,
				Source:         "rule",
			})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("truncation_waste rows: %w", err)
		}
		_ = rows.Close()
	}

	// ── Analyzer 4: sequential_chain (speed) ───────────────────────────────
	// Per trace with ≥3 LLM calls, serialization = sum(latency)/wallclock. A
	// value near 1 means the calls ran back-to-back with no overlap; > 1 means
	// they overlapped (already parallel). We aggregate by workflow (argMin
	// feature_name of the kind='workflow' span, same attribution as WasteInbox)
	// and fire when the average serialization is < 1.3 across ≥5 traces — a
	// workflow that could parallelize its fan-out. est_saved is the serial
	// overhead that could be overlapped, in seconds.
	{
		q := `
WITH workflow_map AS (
    SELECT trace_id, argMin(coalesce(nullIf(feature_name, ''), ''), timestamp) AS wf
    FROM llm_calls
    WHERE org_id = {org_id:String} AND kind = 'workflow'
      AND timestamp >= {from:DateTime('UTC')} AND timestamp < {to:DateTime('UTC')}
    GROUP BY trace_id
),
trace_stats AS (
    SELECT
        trace_id                                                                       AS trace_id,
        toUInt64(count())                                                              AS llm_calls,
        toFloat64(sum(latency_ms))                                                     AS sum_latency,
        toFloat64(max(toUnixTimestamp64Milli(timestamp) + latency_ms)
                  - min(toUnixTimestamp64Milli(timestamp)))                            AS wallclock
    FROM llm_calls
    WHERE org_id    = {org_id:String}
      AND kind      = 'llm'
      AND timestamp >= {from:DateTime('UTC')}
      AND timestamp <  {to:DateTime('UTC')}` + scope.cond("") + `
    GROUP BY trace_id
    HAVING llm_calls >= 3 AND wallclock > 0
)
SELECT
    coalesce(wm.wf, '')                                          AS workflow,
    toUInt64(count())                                            AS traces,
    avg(ts.sum_latency / nullIf(ts.wallclock, 0))               AS avg_serialization,
    avg(ts.sum_latency - ts.wallclock) / 1000                   AS est_saved_seconds
FROM trace_stats ts
LEFT JOIN workflow_map wm ON ts.trace_id = wm.trace_id
GROUP BY workflow
HAVING traces >= 5
   AND avg_serialization < 1.3
ORDER BY est_saved_seconds DESC
LIMIT 5`
		args := scope.params([]any{
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		})
		rows, err := ch.Query(ctx, q, args...)
		if err != nil {
			return nil, fmt.Errorf("recommendations sequential_chain: %w", err)
		}
		for rows.Next() {
			var workflow string
			var traces uint64
			var avgSerialization, estSaved float64
			if err := rows.Scan(&workflow, &traces, &avgSerialization, &estSaved); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan sequential_chain: %w", err)
			}
			if estSaved < 0 {
				estSaved = 0 // don't advertise negative savings
			}
			wfLabel := workflow
			if wfLabel == "" {
				wfLabel = "(unattributed)"
			}
			res.Findings = append(res.Findings, Finding{
				Category:       "speed",
				Severity:       "medium",
				Title:          fmt.Sprintf("%s runs its LLM calls sequentially", wfLabel),
				Detail:         fmt.Sprintf("Across %d traces the calls barely overlap (serialization %.2f×, where 1.0 is fully serial). Independent calls could run concurrently to cut wall-clock time.", traces, avgSerialization),
				Recommendation: "Identify the independent LLM calls in this workflow (no data dependency between them) and issue them concurrently (asyncio.gather / Promise.all) instead of awaiting each in turn.",
				ImpactKind:     "seconds",
				ImpactValue:    estSaved,
				Evidence:       fmt.Sprintf("serialization %.2f× over %d traces, ~%.1fs recoverable/trace", avgSerialization, traces, estSaved),
				Feature:        workflow,
				Source:         "rule",
			})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("sequential_chain rows: %w", err)
		}
		_ = rows.Close()
	}

	// ── Analyzer 5: latency_variance (reliability) ─────────────────────────
	// Models with a fat p99 tail (p99 > 10s AND p99/p50 > 4 over ≥20 calls) are
	// unpredictable: the median is fine but a meaningful slice of users waits
	// many seconds. Impact is the p99 latency in seconds.
	{
		q := `
SELECT
    model                                AS model,
    toUInt64(count())                    AS calls,
    quantile(0.5)(latency_ms)            AS p50,
    quantile(0.99)(latency_ms)           AS p99
FROM llm_calls
WHERE org_id    = {org_id:String}
  AND kind      = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}` + scope.cond("") + `
GROUP BY model
HAVING calls >= 20
   AND p99 > 10000
   AND p99 / nullIf(p50, 0) > 4
ORDER BY p99 DESC
LIMIT 5`
		args := scope.params([]any{
			driver.NamedValue{Name: "org_id", Value: orgID},
			driver.NamedValue{Name: "from", Value: chDateTime(tw.From)},
			driver.NamedValue{Name: "to", Value: chDateTime(tw.To)},
		})
		rows, err := ch.Query(ctx, q, args...)
		if err != nil {
			return nil, fmt.Errorf("recommendations latency_variance: %w", err)
		}
		for rows.Next() {
			var model string
			var calls uint64
			var p50, p99 float64
			if err := rows.Scan(&model, &calls, &p50, &p99); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan latency_variance: %w", err)
			}
			sev := "medium"
			if p99 > 30000 {
				sev = "high"
			}
			ratio := 0.0
			if p50 > 0 {
				ratio = p99 / p50
			}
			res.Findings = append(res.Findings, Finding{
				Category:       "reliability",
				Severity:       sev,
				Title:          fmt.Sprintf("%s has a heavy latency tail", model),
				Detail:         fmt.Sprintf("p99 latency is %.1fs versus a p50 of %.1fs (%.0f× the median). One request in a hundred is dramatically slower than typical, which shows up as intermittent hangs for users.", p99/1000, p50/1000, ratio),
				Recommendation: "Add a per-call timeout + retry-on-timeout for this model, cap max_tokens (long generations dominate the tail), or route overflow to a faster model when the request is latency-sensitive.",
				ImpactKind:     "seconds",
				ImpactValue:    p99 / 1000,
				Evidence:       fmt.Sprintf("p99 %.1fs, p50 %.1fs (%.0f×) over %d calls", p99/1000, p50/1000, ratio, calls),
				Model:          model,
				Source:         "rule",
			})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("latency_variance rows: %w", err)
		}
		_ = rows.Close()
	}

	sortFindings(res.Findings)
	return res, nil
}

// severityRank orders the tiers for the primary sort key (high first).
func severityRank(sev string) int {
	switch sev {
	case "high":
		return 0
	case "medium":
		return 1
	default:
		return 2
	}
}

// sortFindings ranks rule findings by severity (high>medium>low) then by
// impact_value descending. Stable so equal-key findings keep analyzer order.
func sortFindings(fs []Finding) {
	sort.SliceStable(fs, func(i, j int) bool {
		ri, rj := severityRank(fs[i].Severity), severityRank(fs[j].Severity)
		if ri != rj {
			return ri < rj
		}
		return fs[i].ImpactValue > fs[j].ImpactValue
	})
}

// promptAuditItem mirrors the Redis item blob written by ingest for a Phase-B
// prompt audit (see the build contract's Redis-keys section). Only the fields
// we surface are declared; unknown keys are ignored by encoding/json.
type promptAuditItem struct {
	FeatureName   string        `json:"feature_name"`
	PromptVersion string        `json:"prompt_version"`
	Model         string        `json:"model"`
	Project       string        `json:"project"`
	Findings      []findingBlob `json:"findings"`
}

// findingBlob is the on-the-wire (snake_case) Finding as stored in Redis by the
// SDK auditor. Parsed then normalized into a query.Finding.
type findingBlob struct {
	Category       string  `json:"category"`
	Severity       string  `json:"severity"`
	Title          string  `json:"title"`
	Detail         string  `json:"detail"`
	Recommendation string  `json:"recommendation"`
	ImpactKind     string  `json:"impact_kind"`
	ImpactValue    float64 `json:"impact_value"`
	Evidence       string  `json:"evidence"`
	Model          string  `json:"model"`
	Feature        string  `json:"feature"`
	PromptVersion  string  `json:"prompt_version"`
}

// LLMInsightFindings reads the Phase-B prompt-quality audits stashed in Redis by
// ingest and returns them as source="llm_insight" findings. Best-effort by
// design: a nil client or any Redis/JSON error yields nil (the endpoint still
// returns its rule findings). When scope.Project is set, only audits for that
// project are included; otherwise all are.
//
// Keys (per the build contract):
//
//	scopecall:pa:index:{org}      → SET of prompt_shape_hash with stored findings
//	scopecall:pa:item:{org}:{hash} → STRING, the JSON item blob
func LLMInsightFindings(ctx context.Context, rdb *redis.Client, orgID string, scope Scope) []Finding {
	if rdb == nil {
		return nil
	}
	hashes, err := rdb.SMembers(ctx, "scopecall:pa:index:"+orgID).Result()
	if err != nil || len(hashes) == 0 {
		return nil
	}
	var out []Finding
	for _, h := range hashes {
		blob, err := rdb.Get(ctx, "scopecall:pa:item:"+orgID+":"+h).Result()
		if err != nil {
			continue // dropped/expired item — skip, don't fail the batch
		}
		var item promptAuditItem
		if err := json.Unmarshal([]byte(blob), &item); err != nil {
			continue
		}
		if scope.Project != "" && item.Project != scope.Project {
			continue
		}
		for _, fb := range item.Findings {
			category := fb.Category
			if category == "" {
				category = "prompt_quality"
			}
			feature := fb.Feature
			if feature == "" {
				feature = item.FeatureName
			}
			promptVersion := fb.PromptVersion
			if promptVersion == "" {
				promptVersion = item.PromptVersion
			}
			model := fb.Model
			if model == "" {
				model = item.Model
			}
			out = append(out, Finding{
				Category:       category,
				Severity:       fb.Severity,
				Title:          fb.Title,
				Detail:         fb.Detail,
				Recommendation: fb.Recommendation,
				ImpactKind:     fb.ImpactKind,
				ImpactValue:    fb.ImpactValue,
				Evidence:       fb.Evidence,
				Model:          model,
				Feature:        feature,
				Source:         "llm_insight",
				PromptVersion:  promptVersion,
			})
		}
	}
	return out
}
