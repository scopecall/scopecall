// Wire DTO — snake_case throughout to match the ScopeCall ingest API.
// This is NOT a domain model. Conversion from camelCase SDK internals
// happens in the exporter before events are handed to a Transport.
// ESLint naming-convention rules are disabled for this file via .eslintrc.cjs
// (objectLiteralProperty / typeProperty selectors have format: null).

export interface LLMEvent {
  // Identity
  span_id: string;
  // trace_id MUST be non-null. The Rust ingest declares this as `String`,
  // not `Option<String>`; sending null produces a 400. Instrumentation
  // generates trace_id := span_id for single-span (un-traced) calls.
  trace_id: string;
  parent_span_id: string | null; // null at v0.1; populated in v0.3 agent debugger

  // Timing — MUST be Unix epoch milliseconds as a number (f64). The Rust
  // ingest deserializes this as `timestamp: f64` (services-rust/common/src/event.rs).
  // Sending an ISO 8601 string produces a 400 from the ingest service — the
  // SDK swallows that and the user sees no traces.
  timestamp: number;
  latency_ms: number;
  ttft_ms: number | null; // time to first token (streaming only)

  // Model
  model: string;    // resolved canonical ID (e.g. "gpt-4o", not "gpt-4o-2024-11-20")
  provider: string; // "openai" | "anthropic" | "google" | "unknown"

  // Usage
  input_tokens: number;
  output_tokens: number;
  cost_usd: number; // 6 decimal places

  // Status
  status: "success" | "error" | "timeout" | "rate_limited";
  error_message: string | null;

  // Content. Empty string when captureContent=false or when the call has
  // no body (e.g. a stream that errored before any chunk arrived). MUST
  // NOT be `null` on the wire — the Rust ingest declares these as `String`
  // (not `Option<String>`) and explicit null deserializes to a 400. The
  // ingest also has a defensive null_to_empty mapper for older SDKs in
  // the wild, but new SDK builds canonically emit "".
  input_text: string;
  output_text: string;

  // Context
  feature_name: string | null;
  user_id: string | null;
  session_id: string | null;
  /**
   * B2B customer / tenant identifier. Distinct from `user_id` (end-user).
   * Set via the `customerId` opt on sdk.trace() / workflow() / agent() /
   * step(); inherited from parent spans like `user_id`. Powers per-
   * customer cost attribution on the dashboard. (v0.3)
   *
   * PII CONTRACT — customer_id MUST be a tenant / account slug or
   * opaque ID (e.g. "customer_acme", "org_4adb529080de4df8"). Do NOT
   * put raw email addresses, names, or other PII here. The dashboard
   * surfaces this field to viewer-role users alongside user_id and
   * session_id; gating on owner-role is intentionally NOT applied
   * because customer_id is treated as an identifier, not content.
   * If your app needs to attach PII for support workflows, use
   * `extra` (gated on owner-role) instead.
   */
  customer_id: string | null;

  // Metadata
  environment: string;
  sdk_version: string; // injected at build time via __SDK_VERSION__

  // Framework-specific extras — always JSON.stringify'd before storage; never a raw object
  extra: string | null;

  // Extended fields — nullable; populated by instrumentation in future releases
  finish_reason: string | null;       // LLM stop reason: "stop" | "length" | "content_filter" | "tool_calls" | etc.
  cache_read_tokens: number | null;   // tokens read from provider cache (e.g. OpenAI prompt_tokens_details.cached_tokens)
  original_model: string | null;      // model requested before fallback routing; null if no fallback
  budget_state: string | null;        // "enforced" | "fallback" | "passthrough"; null at v0.1.0
  failure_mode: string | null;        // failure classifier output; null at v0.1.0
  tool_calls: string | null;          // JSON-stringified array of tool calls; separate from extra for queryability

  // Prompt version — operator-supplied tag identifying which iteration of a
  // prompt produced this call. Powers the KPI-attribution thesis: "we
  // switched to v3 and p95 latency went up 20% — was it worth the quality
  // gain?". Captured from sdk.trace(name, fn, { promptVersion }) or from
  // ScopeCallConfig.defaultPromptVersion. Always nullable on the wire; an
  // event with prompt_version=null just means the operator didn't tag it.
  prompt_version: string | null;

  /**
   * v0.3 retry attribution. attempt_number is 1-based; default 1 means
   * "first attempt." Set by the caller when the application is doing its
   * own retry loop and wants those retries surfaced in cost reports.
   * Provider-SDK-internal retries (openai-py / anthropic-sdk) are not
   * counted — they don't add to your bill.
   */
  attempt_number?: number;
  /**
   * v0.3 — reason for this retry; null on attempt 1. Ingest enforces:
   * "rate_limit" | "timeout" | "server_error" | "transient_network" |
   * "agent_decision" | "manual" | "unknown".
   */
  retry_reason?: string | null;
  /**
   * v0.3 — true when the call is from a non-production run (eval suite,
   * CI, smoke test, replay, backfill). Lets the dashboard exclude these
   * from cost reports by default — eval/CI typically dominate cost on
   * staging environments and inflate "production cost" if blended.
   */
  is_test?: boolean;

  /**
   * v0.3 — server-derived cost metadata. SERVER-DERIVED: do not set
   * these in SDK code or instrumentation. The Rust processor's reprice()
   * unconditionally overwrites them after server-side pricing, so any
   * value set here is discarded. They live on the wire type because it
   * doubles as the canonical record shape the dashboard reads back via
   * the API.
   *
   * cost_source legal values (closed enum enforced by the processor):
   *   "server_computed" - priced from the pricing table
   *   "sdk_fallback"    - model unknown; kept SDK cost
   *   "unknown_model"   - model unknown AND SDK cost was 0
   *   "container"       - workflow / agent / step row (no model)
   */
  cache_read_cost_usd?: number | null;
  cost_source?: string | null;
  pricing_version?: string | null;

  /**
   * Discriminator for the span kind:
   *   - "llm": an instrumented provider call (OpenAI / Anthropic / Vercel AI).
   *           Has model + tokens + cost.
   *   - "workflow" | "agent" | "step": synthetic container spans emitted
   *           by sdk.trace() / sdk.workflow() / sdk.agent() / sdk.step().
   *           NO model, NO tokens, NO cost — just containers that LLM-call
   *           rows hang under via parent_span_id. Without these rows in
   *           storage the trace tree query `JOIN ON child.parent_span_id
   *           = parent.span_id` returns no parent. The three container
   *           kinds form the workflow → agent → step hierarchy the v0.3
   *           cost-attribution dashboards roll up against. The Rust
   *           ingest validates the closed set { llm | workflow | agent |
   *           step } and rejects anything else. (workflow shipped in
   *           v0.1; agent + step in v0.3.)
   *
   * Optional on the wire for backwards compatibility — pre-v0.1.2 SDKs
   * don't send it. Ingest defaults to "llm" when absent.
   */
  kind?: "llm" | "workflow" | "agent" | "step";
}

/** JSON.stringify replacer: undefined → null so wire format is fully defined */
function replacer(_key: string, value: unknown): unknown {
  return value === undefined ? null : value;
}

export function toWire(event: LLMEvent): string {
  return JSON.stringify(event, replacer);
}
