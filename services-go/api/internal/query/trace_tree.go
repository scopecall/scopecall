package query

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// maxTraceTreeSpans caps how many spans we return for a single trace_id. Real
// agent traces are typically <50 spans; this is a sanity cap, not a UX limit.
const maxTraceTreeSpans = 500

// traceTreeProbeBuffer is how far on either side of a probed timestamp we'll
// scan for spans. Generous because some agent traces span minutes (long-running
// LLM calls + retries), but tight enough to skip 89 of 90 daily partitions.
const traceTreeProbeBuffer = 6 * time.Hour

// TraceTree returns every span belonging to trace_id, ordered by timestamp
// ascending so the caller can build the parent_span_id hierarchy in one pass.
// isOwner controls whether input_text / output_text are returned (viewer role
// gets empty strings, same masking rule as the list/detail endpoints).
//
// Perf: the ClickHouse primary key is (org_id, timestamp, span_id). Without a
// timestamp predicate, this query scans every partition for the org (90 days
// at our default TTL). To bound the scan, the caller can pass a (from, to)
// window — usually carried forward from whatever page navigated here. If both
// are zero, we probe for the trace's first-seen timestamp and constrain to
// ±traceTreeProbeBuffer around it (two round-trips instead of one, but the
// probe is a cheap min() aggregate).
func TraceTree(ctx context.Context, ch driver.Conn, orgID, traceID string, isOwner bool, hintFrom, hintTo time.Time) ([]TraceRow, error) {
	ownerFlag := "0"
	if isOwner {
		ownerFlag = "1"
	}

	from, to := hintFrom, hintTo
	if from.IsZero() || to.IsZero() {
		// Probe for the trace's actual timestamp range. We accept the extra
		// round-trip rather than a full-partition scan because the probe is
		// just a min() projection — much faster than scanning every column.
		probedFrom, probedTo, err := probeTraceWindow(ctx, ch, orgID, traceID)
		if err != nil {
			return nil, err
		}
		if probedFrom.IsZero() {
			// Trace doesn't exist (or isn't in this org). Return empty —
			// caller maps to 404 via the existing nil-rows path.
			return []TraceRow{}, nil
		}
		from = probedFrom.Add(-traceTreeProbeBuffer)
		to = probedTo.Add(traceTreeProbeBuffer)
	}

	const q = `
SELECT
    org_id, trace_id, span_id, parent_span_id,
    timestamp, model, provider,
    input_tokens, output_tokens, cost_usd, input_cost_usd, output_cost_usd,
    latency_ms, ttft_ms,
    status, error_message,
    if({is_owner:UInt8}, input_text, '')  AS input_text,
    if({is_owner:UInt8}, output_text, '') AS output_text,
    feature_name, user_id, session_id, environment, sdk_version,
    if({is_owner:UInt8}, extra, NULL) AS extra,
    prompt_version,
    kind,
    -- v0.3 retry attribution: attempt_number > 1 (with retry_reason) marks a
    -- caller retry. The drawer groups same-span_id rows into an ATTEMPTS list
    -- and tallies the wasted spend on the failed attempts.
    attempt_number, retry_reason,
    -- Cost trust signal — drives the drawer's confidence dot. The list/detail
    -- endpoints already return these; the tree omitted them, so the drawer
    -- showed "unknown" for every span. Surface them here too.
    cost_source, pricing_version
FROM llm_calls
WHERE org_id   = {org_id:String}
  AND trace_id = {trace_id:String}
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
ORDER BY timestamp ASC, span_id ASC
LIMIT 500
`
	rows, err := ch.Query(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "trace_id", Value: traceID},
		driver.NamedValue{Name: "is_owner", Value: ownerFlag},
		driver.NamedValue{Name: "from", Value: chDateTime(from)},
		driver.NamedValue{Name: "to", Value: chDateTime(to)},
	)
	if err != nil {
		return nil, fmt.Errorf("trace tree query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	spans := make([]TraceRow, 0, 16)
	for rows.Next() {
		var t TraceRow
		if err := rows.Scan(
			&t.OrgID, &t.TraceID, &t.SpanID, &t.ParentSpanID,
			&t.Timestamp, &t.Model, &t.Provider,
			&t.InputTokens, &t.OutputTokens, &t.CostUSD, &t.InputCostUSD, &t.OutputCostUSD,
			&t.LatencyMS, &t.TTFTMS,
			&t.Status, &t.ErrorMessage,
			&t.InputText, &t.OutputText,
			&t.FeatureName, &t.UserID, &t.SessionID, &t.Environment, &t.SDKVersion, &t.Extra,
			&t.PromptVersion,
			&t.Kind,
			&t.AttemptNumber, &t.RetryReason,
			&t.CostSource, &t.PricingVersion,
		); err != nil {
			return nil, fmt.Errorf("scan trace span: %w", err)
		}
		spans = append(spans, t)
		if len(spans) >= maxTraceTreeSpans {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("trace tree rows: %w", err)
	}
	return spans, nil
}

// probeTraceWindow finds the min/max timestamp for spans belonging to a
// trace. Used as a fallback to bound the main scan when the caller doesn't
// pass a (from, to) hint. Returns zero times if the trace has no spans.
func probeTraceWindow(ctx context.Context, ch driver.Conn, orgID, traceID string) (time.Time, time.Time, error) {
	const q = `
SELECT min(timestamp), max(timestamp)
FROM llm_calls
WHERE org_id = {org_id:String} AND trace_id = {trace_id:String}`
	row := ch.QueryRow(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "trace_id", Value: traceID},
	)
	var minT, maxT time.Time
	if err := row.Scan(&minT, &maxT); err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("probe trace window: %w", err)
	}
	return minT, maxT, nil
}
