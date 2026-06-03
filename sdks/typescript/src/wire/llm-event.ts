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
  // SDK swallows that and the user sees no traces. (External review P0.)
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
  // the wild, but new SDK builds canonically emit "". (Round-2 review.)
  input_text: string;
  output_text: string;

  // Context
  feature_name: string | null;
  user_id: string | null;
  session_id: string | null;

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
   * Discriminator for the span kind:
   *   - "llm": an instrumented provider call (OpenAI / Anthropic / Vercel AI).
   *           Has model + tokens + cost.
   *   - "workflow": a synthetic span emitted by sdk.trace(). NO model, NO
   *           tokens, NO cost — just a container that LLM-call rows hang
   *           under via parent_span_id. Without these rows in storage the
   *           trace tree query `JOIN ON child.parent_span_id = parent.span_id`
   *           returns no parent, and the "workflow debugger" claim is
   *           cosmetic. (Round-3 external review P0.)
   *
   * Optional on the wire for backwards compatibility — pre-v0.1.2 SDKs
   * don't send it. Ingest defaults to "llm" when absent.
   */
  kind?: "llm" | "workflow";
}

/** JSON.stringify replacer: undefined → null so wire format is fully defined */
function replacer(_key: string, value: unknown): unknown {
  return value === undefined ? null : value;
}

export function toWire(event: LLMEvent): string {
  return JSON.stringify(event, replacer);
}
