package query

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// maxTracesLimit caps the page size. The LIMIT value is inlined into the SQL
// (ClickHouse does not support a parameterized LIMIT clause), so it must be a
// trusted, bounded integer — never a raw client value.
const maxTracesLimit = 1000

type TraceRow struct {
	OrgID        string
	TraceID      string
	SpanID       string
	ParentSpanID *string
	Timestamp    time.Time
	Model        string
	Provider     string
	InputTokens  uint32
	OutputTokens uint32
	CostUSD      float64
	// Cost components — populated at ingest from per-model pricing so the
	// dashboard can show a stored breakdown without recomputation.
	InputCostUSD  float64
	OutputCostUSD float64
	LatencyMS     uint32
	TTFTMS        *uint32
	Status        string
	ErrorMessage  *string
	InputText     string
	OutputText    string
	FeatureName   *string
	UserID        *string
	SessionID     *string
	// v0.3 — B2B customer / tenant identifier (distinct from UserID).
	CustomerID    *string
	Environment   string
	SDKVersion    string
	Extra         *string
	PromptVersion *string
	// Span discriminator: "llm" (default), "workflow", "agent", "step".
	// agent/step joined the closed set in v0.3 for cost rollups across
	// the workflow → agent → step hierarchy.
	Kind string
	// v0.3 — retry attribution. AttemptNumber defaults to 1; RetryReason
	// is one of the closed enum values when AttemptNumber > 1.
	AttemptNumber uint16
	RetryReason   *string
	// v0.3 — non-production traffic flag for the dashboard's "Production
	// only" toggle.
	IsTest bool
	// v0.3 — server-derived cost metadata.
	CacheReadCostUSD float64
	CostSource       string
	PricingVersion   *string
}

type ListTracesArgs struct {
	OrgID       string
	Window      TimeWindow
	IsOwner     bool
	Cursor      string
	Limit       int
	Model       string
	Status      string
	Provider    string
	FeatureName string
	UserID      string
	Environment string
	// Prompt version filter — supports the same nullSentinel as other
	// dimensions so the Prompts page's "(none)" row can drill into untagged
	// calls.
	PromptVersion string
	// v0.3 — B2B tenant filter. Drilled into from /dashboard/customers + the
	// workflow detail by-customer panel. Supports nullSentinel to surface
	// calls with no customer_id (the "Unattributed" tile on the customers page).
	CustomerID string
	// v0.3 — cost-attribution-hierarchy filters. Each maps to a different
	// SQL shape because the three levels of the hierarchy have different
	// structural relationships to LLM calls (see hierarchyFilterClauses):
	//
	//   Workflow → trace_id IN (...)        — workflow is trace-level
	//   Step     → parent_span_id IN (...)  — step is the direct parent
	//   Agent    → parent_span_id IN (
	//                  agent UNION step-under-agent)
	//                                       — agent can be 1 or 2 hops up
	//
	// All three are the correct way to scope traces to "all calls inside
	// this workflow / agent / step" — NOT feature_name equality, which on
	// LLM rows resolves to the step/call name (so feature_name='refund-bot'
	// would match the workflow span but miss every LLM call inside it).
	// Drilled into from the Waste Inbox, workflow-detail page, and the
	// Workflow Treemap.
	Workflow string // workflow feature_name on a kind='workflow' span
	Agent    string // agent feature_name on a kind='agent' span
	Step     string // step feature_name on a kind='step' span
	// Free-text search: exact-match on ID columns, plus case-insensitive
	// substring on input/output/error text. Text columns are excluded from
	// the search when IsOwner is false — otherwise a viewer could deduce
	// content they aren't allowed to read.
	Query string
}

// nullSentinel marks "filter where this column IS NULL" — used by the
// "(none)" bucket drill-down from Cost so users can click into untagged calls.
const nullSentinel = "__null__"

type ListTracesResult struct {
	Traces     []TraceRow
	NextCursor string
}

// cursorPayload is the page-marker carried in `?cursor=...`. SECURITY INVARIANT:
// the cursor MUST NOT carry any cross-tenant authorization data — only
// pagination position (`ts` + `id`). All tenant scoping comes from JWT claims
// in the request, NEVER from the cursor. This is what makes it safe to keep
// the cursor unsigned (base64 JSON).
//
// If a future endpoint wants to put anything beyond pagination position into
// the cursor (e.g. a filter set the server should "remember"), it MUST sign or
// HMAC the cursor — otherwise a user could tamper their way to data they
// shouldn't see.
type cursorPayload struct {
	TS   time.Time `json:"ts"`
	SPID string    `json:"id"`
}

func encodeCursor(ts time.Time, spanID string) string {
	b, _ := json.Marshal(cursorPayload{TS: ts, SPID: spanID})
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string) (time.Time, string, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, "", err
	}
	var p cursorPayload
	if err := json.Unmarshal(b, &p); err != nil {
		return time.Time{}, "", err
	}
	return p.TS, p.SPID, nil
}

func ListTraces(ctx context.Context, ch driver.Conn, args ListTracesArgs) (*ListTracesResult, error) {
	isOwner := "0"
	if args.IsOwner {
		isOwner = "1"
	}

	limit := args.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > maxTracesLimit {
		limit = maxTracesLimit
	}

	// Optional filter conditions. Each entry is one WHERE conjunct; the matching
	// NamedValue is appended in lockstep so the order doesn't matter to the
	// driver (params are looked up by name). "1=1" is the no-op when none apply.
	conds := []string{}
	queryArgs := []any{
		driver.NamedValue{Name: "org_id", Value: args.OrgID},
		driver.NamedValue{Name: "from", Value: chDateTime(args.Window.From)},
		driver.NamedValue{Name: "to", Value: chDateTime(args.Window.To)},
		driver.NamedValue{Name: "is_owner", Value: isOwner},
	}

	if args.Cursor != "" {
		ts, sid, err := decodeCursor(args.Cursor)
		if err != nil {
			return nil, fmt.Errorf("invalid cursor: %w", err)
		}
		conds = append(conds, "(timestamp < {cursor_ts:DateTime64(9, 'UTC')} OR (timestamp = {cursor_ts:DateTime64(9, 'UTC')} AND span_id < {cursor_id:String}))")
		queryArgs = append(queryArgs,
			driver.NamedValue{Name: "cursor_ts", Value: chDateTime64(ts)},
			driver.NamedValue{Name: "cursor_id", Value: sid},
		)
	}

	// (column, NamedValue name, value) — driven from args fields. Empty value
	// skips; the nullSentinel emits `IS NULL` so the "(none)" drill-in works.
	filters := []struct{ col, name, val string }{
		{"model", "model", args.Model},
		{"status", "status", args.Status},
		{"provider", "provider", args.Provider},
		{"feature_name", "feature_name", args.FeatureName},
		{"user_id", "user_id", args.UserID},
		{"environment", "environment", args.Environment},
		{"prompt_version", "prompt_version", args.PromptVersion},
		{"customer_id", "customer_id", args.CustomerID},
	}
	for _, f := range filters {
		if f.val == "" {
			continue
		}
		if f.val == nullSentinel {
			conds = append(conds, fmt.Sprintf("%s IS NULL", f.col))
			continue
		}
		conds = append(conds, fmt.Sprintf("%s = {%s:String}", f.col, f.name))
		queryArgs = append(queryArgs, driver.NamedValue{Name: f.name, Value: f.val})
	}

	// v0.3 — workflow / agent / step hierarchy filters. The three filters
	// have DIFFERENT structural meanings, so they need different subqueries:
	//
	//   workflow:  trace-level. Matches every span in any trace whose
	//              kind='workflow' root has feature_name = ?.
	//              → trace_id IN (...)
	//
	//   step:      direct-parent. Matches LLM rows whose immediate parent
	//              span is a kind='step' span with feature_name = ?.
	//              Step is the nearest meaningful ancestor of an LLM call
	//              by design, so a single parent_span_id IN-list captures
	//              the right set with no ambiguity.
	//              → parent_span_id IN (step.span_id)
	//
	//   agent:     ancestor-up-to-two-hops. An LLM call can sit DIRECTLY
	//              under an agent (workflow → agent → llm), OR under a
	//              step which sits under the agent (workflow → agent →
	//              step → llm). Both are valid; the filter has to match
	//              either parent_span_id directly or transitively via the
	//              step layer. We UNION the two parent-id sets inside the
	//              IN-list.
	//              → parent_span_id IN (
	//                  agent.span_id
	//                  UNION ALL
	//                  step.span_id WHERE step.parent_span_id = agent.span_id
	//                )
	//
	// trace_id IN with `agent` was a previous-revision bug: it returned
	// every LLM call in a trace that contained the agent anywhere, not
	// just the calls actually under that agent. Same shape of bug for
	// step.
	//
	// All subqueries are bounded by the same org_id + (prior-window-safe)
	// time range — workflow/agent/step spans emitted up to a day before
	// the visible window still attribute their children, since users
	// re-querying older slices need the cross-window join to resolve.
	hConds, hArgs := hierarchyFilterClauses(args)
	conds = append(conds, hConds...)
	// queryArgs is []any (ch.Query is variadic), so we widen each NamedValue
	// as we splice in. Same pattern as the rest of this builder.
	for _, a := range hArgs {
		queryArgs = append(queryArgs, a)
	}

	// Free-text search. ID columns match exactly; text columns use
	// positionCaseInsensitive (returns 1-based index of substring, 0 if absent).
	// For viewer role, text columns are excluded so search can't be used to
	// confirm text contents the role isn't allowed to read.
	if args.Query != "" {
		var clauses []string
		clauses = append(clauses,
			"span_id = {q:String}",
			"trace_id = {q:String}",
			"coalesce(session_id, '') = {q:String}",
			"coalesce(user_id, '') = {q:String}",
		)
		if args.IsOwner {
			clauses = append(clauses,
				"positionCaseInsensitive(input_text, {q:String}) > 0",
				"positionCaseInsensitive(output_text, {q:String}) > 0",
				"positionCaseInsensitive(coalesce(error_message, ''), {q:String}) > 0",
			)
		}
		conds = append(conds, "("+strings.Join(clauses, " OR ")+")")
		queryArgs = append(queryArgs, driver.NamedValue{Name: "q", Value: args.Query})
	}

	whereExtra := "1=1"
	if len(conds) > 0 {
		whereExtra = strings.Join(conds, " AND ")
	}

	q := fmt.Sprintf(`
SELECT
    org_id, trace_id, span_id, parent_span_id,
    timestamp, model, provider,
    input_tokens, output_tokens, cost_usd, input_cost_usd, output_cost_usd,
    latency_ms, ttft_ms,
    status, error_message,
    if({is_owner:UInt8}, input_text, '')  AS input_text,
    if({is_owner:UInt8}, output_text, '') AS output_text,
    feature_name,
    -- Identifier columns (user_id / session_id / customer_id) are
    -- INTENTIONALLY surfaced to viewer-role users alongside owners.
    -- These are tenant attribution identifiers (slugs / UUIDs / account
    -- IDs the app assigns), not free-form content. Same convention as
    -- org_id in every response. If a customer's SDK starts putting raw
    -- PII into these fields, the policy needs revisiting — see RFC at
    -- the schema's privacy classification.
    user_id, session_id, customer_id,
    environment, sdk_version,
    -- extra is SDK-supplied freeform JSON; could contain PII / debug payload.
    -- Gate on owner role the same way as input_text/output_text so viewers
    -- can't see arbitrary content the customer's SDK chose to attach.
    if({is_owner:UInt8}, extra, NULL) AS extra,
    prompt_version,
    kind,
    attempt_number, retry_reason, is_test,
    cache_read_cost_usd, cost_source, pricing_version
FROM llm_calls
-- The Traces list page is "your LLM call log" — workflow spans don't fit
-- the table's columns (model, tokens, cost are all empty). They surface
-- on the trace TREE view (no filter) and the Flow Map.
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}
  AND %s
ORDER BY timestamp DESC, span_id DESC
LIMIT %d
`, whereExtra, limit+1)

	rows, err := ch.Query(ctx, q, queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("list traces: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var traces []TraceRow
	for rows.Next() {
		var t TraceRow
		if err := rows.Scan(
			&t.OrgID, &t.TraceID, &t.SpanID, &t.ParentSpanID,
			&t.Timestamp, &t.Model, &t.Provider,
			&t.InputTokens, &t.OutputTokens, &t.CostUSD, &t.InputCostUSD, &t.OutputCostUSD,
			&t.LatencyMS, &t.TTFTMS,
			&t.Status, &t.ErrorMessage,
			&t.InputText, &t.OutputText,
			&t.FeatureName, &t.UserID, &t.SessionID, &t.CustomerID, &t.Environment, &t.SDKVersion, &t.Extra,
			&t.PromptVersion,
			&t.Kind,
			&t.AttemptNumber, &t.RetryReason, &t.IsTest,
			&t.CacheReadCostUSD, &t.CostSource, &t.PricingVersion,
		); err != nil {
			return nil, fmt.Errorf("scan trace: %w", err)
		}
		traces = append(traces, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("traces rows: %w", err)
	}

	res := &ListTracesResult{}
	if len(traces) > limit {
		last := traces[limit-1]
		res.NextCursor = encodeCursor(last.Timestamp, last.SpanID)
		traces = traces[:limit]
	}
	res.Traces = traces
	return res, nil
}

func GetTrace(ctx context.Context, ch driver.Conn, orgID, spanID string, isOwner bool) (*TraceRow, error) {
	ownerFlag := "0"
	if isOwner {
		ownerFlag = "1"
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
    feature_name,
    -- Identifier columns (user_id / session_id / customer_id) are
    -- INTENTIONALLY surfaced to viewer-role users alongside owners.
    -- These are tenant attribution identifiers (slugs / UUIDs / account
    -- IDs the app assigns), not free-form content. Same convention as
    -- org_id in every response. If a customer's SDK starts putting raw
    -- PII into these fields, the policy needs revisiting — see RFC at
    -- the schema's privacy classification.
    user_id, session_id, customer_id,
    environment, sdk_version,
    -- extra is SDK-supplied freeform JSON; could contain PII / debug payload.
    -- Gate on owner role the same way as input_text/output_text so viewers
    -- can't see arbitrary content the customer's SDK chose to attach.
    if({is_owner:UInt8}, extra, NULL) AS extra,
    prompt_version,
    kind,
    attempt_number, retry_reason, is_test,
    cache_read_cost_usd, cost_source, pricing_version
FROM llm_calls
-- GetTrace deliberately does NOT filter on kind. The user clicked a
-- specific span_id from the trace tree or a direct link; that could be
-- either an LLM call or a workflow span and we should hand back whatever
-- they asked for. The handler / frontend already keys rendering off
-- TraceRow.Kind.
WHERE org_id = {org_id:String}
  AND span_id = {span_id:String}
LIMIT 1
`
	row := ch.QueryRow(ctx, q,
		driver.NamedValue{Name: "org_id", Value: orgID},
		driver.NamedValue{Name: "span_id", Value: spanID},
		driver.NamedValue{Name: "is_owner", Value: ownerFlag},
	)

	var t TraceRow
	err := row.Scan(
		&t.OrgID, &t.TraceID, &t.SpanID, &t.ParentSpanID,
		&t.Timestamp, &t.Model, &t.Provider,
		&t.InputTokens, &t.OutputTokens, &t.CostUSD, &t.InputCostUSD, &t.OutputCostUSD,
		&t.LatencyMS, &t.TTFTMS,
		&t.Status, &t.ErrorMessage,
		&t.InputText, &t.OutputText,
		&t.FeatureName, &t.UserID, &t.SessionID, &t.CustomerID, &t.Environment, &t.SDKVersion, &t.Extra,
		&t.PromptVersion,
		&t.Kind,
		&t.AttemptNumber, &t.RetryReason, &t.IsTest,
		&t.CacheReadCostUSD, &t.CostSource, &t.PricingVersion,
	)
	if err != nil {
		// Only sql.ErrNoRows means "not found" — everything else (timeout,
		// network blip, schema drift, ClickHouse outage) is a real error
		// that must bubble up. Otherwise on-call chases phantom data-loss
		// tickets while real failures stay invisible (security review #3).
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("scan trace row: %w", err)
	}
	return &t, nil
}

// hierarchyFilterClauses produces the SQL conditions + named-arg slice that
// implement the v0.3 workflow/agent/step trace filters. Extracted so the
// SQL-shape contract can be asserted by unit tests without a live
// ClickHouse — getting the parent-vs-trace semantics right per filter type
// is the correctness boundary the previous revision missed.
//
// Contract per filter:
//
//	workflow → trace_id IN (workflow.trace_id)        — trace-level
//	step     → parent_span_id IN (step.span_id)       — direct parent
//	agent    → parent_span_id IN (                    — ancestor (≤2 hops)
//	              agent.span_id
//	              UNION ALL
//	              step.span_id WHERE step's parent is the agent
//	           )
//
// All subqueries are scoped by org_id and `timestamp ∈ [from - 1 day, to)` —
// the one-day grace covers workflow/agent/step spans emitted slightly
// before the requested visible window (relevant when users re-query a
// historical slice).
func hierarchyFilterClauses(args ListTracesArgs) ([]string, []driver.NamedValue) {
	var conds []string
	var qa []driver.NamedValue
	if args.Workflow != "" {
		conds = append(conds, `trace_id IN (
            SELECT trace_id FROM llm_calls
            WHERE org_id = {org_id:String}
              AND kind = 'workflow'
              AND coalesce(nullIf(feature_name, ''), '') = {wf_name:String}
              AND timestamp >= {from:DateTime('UTC')} - INTERVAL 1 DAY
              AND timestamp <  {to:DateTime('UTC')}
        )`)
		qa = append(qa, driver.NamedValue{Name: "wf_name", Value: args.Workflow})
	}
	if args.Step != "" {
		conds = append(conds, `parent_span_id IN (
            SELECT span_id FROM llm_calls
            WHERE org_id = {org_id:String}
              AND kind = 'step'
              AND coalesce(nullIf(feature_name, ''), '') = {st_name:String}
              AND timestamp >= {from:DateTime('UTC')} - INTERVAL 1 DAY
              AND timestamp <  {to:DateTime('UTC')}
        )`)
		qa = append(qa, driver.NamedValue{Name: "st_name", Value: args.Step})
	}
	if args.Agent != "" {
		// UNION ALL — both halves emit span_id, the outer IN-list dedupes
		// at lookup time. ALL (not UNION) avoids a sort/dedupe step in CH;
		// a span_id can't legitimately appear under both an agent and a
		// step-under-agent at the same time, so dedup would be a no-op.
		conds = append(conds, `parent_span_id IN (
            SELECT span_id FROM llm_calls
            WHERE org_id = {org_id:String}
              AND kind = 'agent'
              AND coalesce(nullIf(feature_name, ''), '') = {ag_name:String}
              AND timestamp >= {from:DateTime('UTC')} - INTERVAL 1 DAY
              AND timestamp <  {to:DateTime('UTC')}
            UNION ALL
            SELECT s.span_id FROM llm_calls s
            INNER JOIN llm_calls a ON s.parent_span_id = a.span_id
            WHERE s.org_id = {org_id:String}
              AND a.org_id = {org_id:String}
              AND s.kind = 'step'
              AND a.kind = 'agent'
              AND coalesce(nullIf(a.feature_name, ''), '') = {ag_name:String}
              AND s.timestamp >= {from:DateTime('UTC')} - INTERVAL 1 DAY
              AND s.timestamp <  {to:DateTime('UTC')}
              AND a.timestamp >= {from:DateTime('UTC')} - INTERVAL 1 DAY
              AND a.timestamp <  {to:DateTime('UTC')}
        )`)
		qa = append(qa, driver.NamedValue{Name: "ag_name", Value: args.Agent})
	}
	return conds, qa
}
