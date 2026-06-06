use serde::{Deserialize, Serialize};

/// Maps explicit JSON `null` to an empty string for `String` fields.
/// `#[serde(default)]` alone only fills in *missing* fields — an explicit
/// `null` in the JSON still errors with "invalid type: null, expected a
/// string". Used on input_text / output_text so SDKs that emit `null`
/// when captureContent is off don't 400 the entire batch.
fn null_to_empty<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// One LLM call captured by the SDK. Mirrors the Python SDK's LLMEvent dataclass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmEvent {
    // Identity
    pub trace_id: String,
    pub span_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,

    // Timing — timestamp is Unix epoch milliseconds
    pub timestamp: f64,
    pub latency_ms: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u32>,

    // Model
    pub model: String,
    pub provider: String,

    // Usage
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// Total cost. Server-authoritative as of v0.1.1: the processor overwrites
    /// this with `input_cost_usd + output_cost_usd` from the bundled pricing
    /// table. The SDK still computes a value as a fallback for unknown models
    /// the operator hasn't added to the table yet.
    pub cost_usd: f64,
    /// Input-token portion of cost. Populated by processor::pricing. `None`
    /// on the wire (SDKs don't send it); always `Some` after enrichment
    /// when the model is known. When unknown, processor leaves it `None`
    /// and the ClickHouse Float64 column DEFAULT 0 takes effect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_cost_usd: Option<f64>,

    // Status
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,

    // Content
    //
    // Both fields are `String` (not `Option<String>`) because the typical
    // payload always has them. SDKs that turn off content capture
    // (captureContent: false) MUST emit "" — not null. Older SDKs that
    // shipped null here would trigger a 400 from serde otherwise.
    //
    // `deserialize_with = "null_to_empty"` makes the ingest tolerate either
    // shape ("" or null) so a mixed-version SDK fleet keeps working during
    // upgrades. This is belt-and-suspenders: the canonical SDK behaviour
    // is now "" (see TS instrumentation/*.ts buildEvent).
    #[serde(default, deserialize_with = "null_to_empty")]
    pub input_text: String,
    #[serde(default, deserialize_with = "null_to_empty")]
    pub output_text: String,

    // Context
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// B2B customer / tenant identifier. Distinct from `user_id` (end-user).
    /// Powers per-customer cost attribution on the dashboard. Optional with
    /// `#[serde(default)]` so pre-v0.3 SDKs (which don't send the field)
    /// keep working — they store NULL on the ClickHouse column. (v0.3)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub customer_id: Option<String>,

    /// v0.3 — 1-based attempt index from the caller's perspective. Default 1.
    /// Increments only when the APPLICATION retries; provider-SDK-internal
    /// retries are not counted (they don't add to your bill).
    #[serde(default = "default_attempt_number")]
    pub attempt_number: u16,

    /// v0.3 — reason for this retry. None on attempt 1. Validated against the
    /// closed enum {rate_limit, timeout, server_error, transient_network,
    /// agent_decision, manual, unknown}.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_reason: Option<String>,

    /// v0.3 — true for non-production traffic (eval suites, CI, smoke tests,
    /// replays, backfills). Dashboard's "Production only" toggle filters
    /// these out so they don't inflate cost reports.
    #[serde(default)]
    pub is_test: bool,

    /// v0.3 — cost of the cached portion of input tokens (Anthropic /
    /// OpenAI prompt caching discounts). Derived server-side in the
    /// processor's reprice(); never SDK-supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_cost_usd: Option<f64>,

    /// v0.3 — trust signal for cost_usd. Derived server-side; one of:
    ///   "server_computed" - reprice() set cost from the pricing table
    ///   "sdk_fallback"    - model unknown to pricing table; kept SDK cost
    ///   "unknown_model"   - model unknown AND SDK cost was 0
    /// Lets the dashboard show a confidence indicator next to costs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_source: Option<String>,

    /// v0.3 — pricing-table version that produced cost_usd (typically a
    /// YYYY-MM-DD verification date). Stamped by reprice(); never SDK-
    /// supplied. Makes historical re-pricing auditable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing_version: Option<String>,

    // Metadata
    pub environment: String,
    pub sdk_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,

    // Extended fields — nullable; populated by instrumentation in future releases
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<String>,

    // Operator-supplied prompt iteration identifier. Powers the
    // KPI-attribution use-case (cost/latency/quality per prompt version).
    // Nullable on wire; null just means "the SDK call wasn't tagged".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_version: Option<String>,

    /// Span discriminator: "llm" (default) for instrumented provider calls,
    /// "workflow" for synthetic spans emitted by sdk.trace() so the trace
    /// tree has a real parent row to JOIN against. Defaults to "llm" via
    /// the helper below so pre-v0.1.2 SDKs (which don't send this field)
    /// remain compatible.
    #[serde(default = "default_kind")]
    pub kind: String,
}

/// Default for `LlmEvent::kind` when the SDK payload omits it.
/// Anything reaching the ingest without this field is from an older SDK
/// and is definitionally an LLM call (workflow spans require the field).
fn default_kind() -> String {
    "llm".to_owned()
}

/// v0.3 — pre-0.3 SDKs don't emit attempt_number; assume first attempt.
fn default_attempt_number() -> u16 {
    1
}

// ─────────────────────────────────────────────────────────────────────────────
// Field length caps. Enforced at ingest before anything reaches the queue.
//
// Why this matters: every string field flows through Redpanda → ClickHouse →
// dashboard → React Flow SVG node label. A 9MB feature_name doesn't trigger
// SQL injection (we escape), but it WILL freeze every dashboard tab that
// renders that label. Without these caps, a malicious or buggy SDK can DoS
// every team member's dashboard with a single LLM call.
//
// The caps are sized to be generous for legitimate use:
//   - Identifiers: ≤128 (UUIDs are 36, our own gen is ~32, hex span IDs ≤64)
//   - Labels:      ≤256 (model names, feature names, env names)
//   - Tags:        ≤4 KB (error messages, JSON extra blobs, finish reasons)
//   - Bodies:      ≤64 KB (input_text, output_text, serialized tool_calls)
//   - Batch:       ≤1000 events per request
// ─────────────────────────────────────────────────────────────────────────────

pub const MAX_ID_LEN: usize = 128;
pub const MAX_LABEL_LEN: usize = 256;
pub const MAX_TAG_LEN: usize = 4 * 1024;
pub const MAX_BODY_LEN: usize = 64 * 1024;
pub const MAX_BATCH_EVENTS: usize = 1000;

/// Returned by [`LlmEvent::validate`] when a field is too long. The string is
/// safe to surface to the SDK author so they can locate the offending field.
#[derive(Debug)]
pub struct ValidationError(pub String);

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ValidationError {}

fn check_len(name: &str, value: &str, max: usize) -> Result<(), ValidationError> {
    if value.len() > max {
        return Err(ValidationError(format!(
            "{} too long ({} bytes; max {})",
            name,
            value.len(),
            max
        )));
    }
    Ok(())
}

fn check_opt(name: &str, value: &Option<String>, max: usize) -> Result<(), ValidationError> {
    match value {
        Some(v) => check_len(name, v, max),
        None => Ok(()),
    }
}

impl LlmEvent {
    /// Reject events with absurdly long string fields. Cheap O(field-count)
    /// check; runs once per event in the ingest handler before serialization.
    pub fn validate(&self) -> Result<(), ValidationError> {
        // Identifiers
        check_len("trace_id", &self.trace_id, MAX_ID_LEN)?;
        check_len("span_id", &self.span_id, MAX_ID_LEN)?;
        check_opt("parent_span_id", &self.parent_span_id, MAX_ID_LEN)?;
        check_opt("user_id", &self.user_id, MAX_ID_LEN)?;
        check_opt("session_id", &self.session_id, MAX_ID_LEN)?;
        check_opt("customer_id", &self.customer_id, MAX_ID_LEN)?;

        // v0.3 retry_reason closed enum. None or one of the documented
        // reasons. Reject anything else so the ClickHouse LowCardinality
        // dictionary stays bounded and the dashboard can render named
        // categories without an "(unknown values…)" bucket leaking in.
        if let Some(reason) = &self.retry_reason {
            match reason.as_str() {
                "rate_limit" | "timeout" | "server_error" | "transient_network"
                | "agent_decision" | "manual" | "unknown" => {}
                other => {
                    return Err(ValidationError(format!(
                        "retry_reason must be one of \
                         'rate_limit' | 'timeout' | 'server_error' | \
                         'transient_network' | 'agent_decision' | 'manual' | \
                         'unknown', got {:?}",
                        other,
                    )))
                }
            }
        }
        // attempt_number sanity: bounded UInt16 already caps at 65535;
        // a real retry loop running 65k attempts is a different problem.
        // Reject 0 (1-based per the docstring); allow up to MAX_ATTEMPTS
        // to catch buggy SDKs sending bogus values.
        const MAX_ATTEMPTS: u16 = 1000;
        if self.attempt_number == 0 {
            return Err(ValidationError(
                "attempt_number must be >= 1 (1 = first attempt)".to_owned(),
            ));
        }
        if self.attempt_number > MAX_ATTEMPTS {
            return Err(ValidationError(format!(
                "attempt_number ({}) exceeds sanity bound {}",
                self.attempt_number, MAX_ATTEMPTS,
            )));
        }

        // Labels
        check_len("model", &self.model, MAX_LABEL_LEN)?;
        check_len("provider", &self.provider, MAX_LABEL_LEN)?;
        check_len("environment", &self.environment, MAX_LABEL_LEN)?;
        check_len("sdk_version", &self.sdk_version, MAX_LABEL_LEN)?;
        check_opt("feature_name", &self.feature_name, MAX_LABEL_LEN)?;
        check_opt("original_model", &self.original_model, MAX_LABEL_LEN)?;
        // prompt_version is a label, not a free-form blob — caps at LABEL_LEN
        // because it ends up on a ClickHouse LowCardinality column and a
        // multi-KB value there causes catastrophic dict explosion.
        check_opt("prompt_version", &self.prompt_version, MAX_LABEL_LEN)?;
        // kind is an enum, not a free-form label. Reject anything outside
        // the closed set so a hostile / buggy SDK can't push arbitrary
        // strings into the LowCardinality dictionary AND can't bypass the
        // processor's "skip pricing for container rows" gate by claiming
        // a container kind with a real cost.
        //
        // v0.3 expansion: agent + step join workflow as container kinds.
        // They share workflow's semantics (no model, no tokens, no cost
        // of their own — they aggregate children). The processor's
        // reprice() treats all three identically.
        match self.kind.as_str() {
            "llm" | "workflow" | "agent" | "step" => {}
            other => {
                return Err(ValidationError(format!(
                    "kind must be one of 'llm' | 'workflow' | 'agent' | 'step', got {:?}",
                    other,
                )))
            }
        }

        // Tags
        check_opt("error_message", &self.error_message, MAX_TAG_LEN)?;
        check_opt("extra", &self.extra, MAX_TAG_LEN)?;
        check_opt("budget_state", &self.budget_state, MAX_TAG_LEN)?;
        check_opt("failure_mode", &self.failure_mode, MAX_TAG_LEN)?;
        check_opt("finish_reason", &self.finish_reason, MAX_TAG_LEN)?;

        // Bodies
        check_len("input_text", &self.input_text, MAX_BODY_LEN)?;
        check_len("output_text", &self.output_text, MAX_BODY_LEN)?;
        check_opt("tool_calls", &self.tool_calls, MAX_BODY_LEN)?;

        Ok(())
    }
}

/// Batch payload from SDK → Ingest (POST /v1/ingest body).
#[derive(Debug, Deserialize)]
pub struct IngestBatch {
    pub events: Vec<LlmEvent>,
    pub sent_at: String,
}

impl IngestBatch {
    /// Validate the batch as a whole + each event individually.
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.events.len() > MAX_BATCH_EVENTS {
            return Err(ValidationError(format!(
                "batch has too many events ({}; max {})",
                self.events.len(),
                MAX_BATCH_EVENTS
            )));
        }
        for (i, ev) in self.events.iter().enumerate() {
            ev.validate()
                .map_err(|e| ValidationError(format!("events[{}]: {}", i, e.0)))?;
        }
        Ok(())
    }
}

/// Event enriched with org_id, written to Redpanda and eventually ClickHouse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichedEvent {
    pub org_id: String,
    #[serde(flatten)]
    pub event: LlmEvent,
}
