use anyhow::Context;
use clickhouse::Row;
use common::event::EnrichedEvent;
use serde::Serialize;
use tracing::debug;

/// ClickHouse row matching the llm_calls DDL in schemas/clickhouse/001_initial.sql.
///
/// ## Why this borrows (`&'a str`, not `String`)
///
/// This row is a short-lived *view* over an `EnrichedEvent` that exists only
/// long enough to be serialized into the RowBinary insert buffer. Owning
/// `String`s here would mean deep-cloning every field — including the up-to-
/// 64 KB `input_text` / `output_text` bodies — once per event, on the hot
/// path, every flush. Borrowing makes row construction allocation-free: the
/// `From<&EnrichedEvent>` impl below just copies pointers + the Copy scalars.
/// The borrow is sound because `insert_batch` keeps the source slice alive
/// for the whole write loop, and each row is dropped right after
/// `inserter.write(&row)` consumes it.
#[derive(Debug, Row, Serialize)]
pub struct LlmCallRow<'a> {
    pub org_id: &'a str,
    pub trace_id: &'a str,
    pub span_id: &'a str,
    pub parent_span_id: Option<&'a str>,
    /// Milliseconds since Unix epoch → ClickHouse DateTime64(3)
    pub timestamp: i64,
    pub latency_ms: u32,
    pub ttft_ms: Option<u32>,
    pub model: &'a str,
    pub provider: &'a str,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cost_usd: f64,
    // Cost components — populated by the processor's Pricer at enrichment
    // time. When the model is unknown to the pricing table, both components
    // are 0 and `cost_usd` falls back to the SDK-supplied value.
    //
    // Binding contract (clickhouse-rs 0.12+): the derive emits
    // `INSERT INTO llm_calls (col1, col2, ...) FORMAT RowBinary` using
    // the struct's field NAMES from R::COLUMN_NAMES, so binding is
    // name-based, not positional. Struct field ORDER only
    // controls the column-list ordering in the SQL — it does NOT have to
    // match the ClickHouse DDL order (which itself drifts as ALTER ADD
    // COLUMN ... AFTER ... migrations splice columns into the middle).
    // What MUST match is the field NAME to the DDL column name, exactly.
    pub input_cost_usd: f64,
    pub output_cost_usd: f64,
    pub status: &'a str,
    pub error_message: Option<&'a str>,
    pub input_text: &'a str,
    pub output_text: &'a str,
    pub feature_name: Option<&'a str>,
    pub user_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    /// v0.3: B2B customer / tenant attribution. NULL for pre-v0.3 SDKs.
    /// Position matches migration 006 (added AFTER session_id).
    pub customer_id: Option<&'a str>,
    /// v0.3: 1-based caller-attempt index. Default 1 for pre-v0.3 SDKs.
    /// Position matches migration 007.
    pub attempt_number: u16,
    /// v0.3: retry_reason closed enum. NULL on first attempt.
    pub retry_reason: Option<&'a str>,
    /// v0.3: marks non-production traffic for dashboard filtering.
    pub is_test: bool,
    /// v0.3: cost of the cached input portion. Derived server-side. 0 when
    /// the model has no cache_read pricing rate.
    pub cache_read_cost_usd: f64,
    /// v0.3: trust signal for cost_usd. Closed enum:
    /// "server_computed" | "sdk_fallback" | "unknown_model" | "container".
    /// The "container" value is set by reprice() on workflow/agent/step
    /// rows so the dashboard's cost-confidence indicator can distinguish
    /// synthetic spans from real LLM calls.
    pub cost_source: &'a str,
    /// v0.3: pricing-table version that produced cost_usd. YYYY-MM-DD.
    pub pricing_version: Option<&'a str>,
    pub environment: &'a str,
    pub sdk_version: &'a str,
    pub extra: Option<&'a str>,
    pub finish_reason: Option<&'a str>,
    pub cache_read_tokens: Option<u32>,
    pub original_model: Option<&'a str>,
    pub budget_state: Option<&'a str>,
    pub failure_mode: Option<&'a str>,
    pub tool_calls: Option<&'a str>,
    pub prompt_version: Option<&'a str>,
    /// "llm" | "workflow" | "agent" | "step" — agent + step joined the
    /// closed set in v0.3 for cost rollups across the workflow → agent
    /// → step hierarchy. See schemas/clickhouse/004_span_kind.sql for
    /// the original column + the v0.3 migrations that expanded the enum.
    pub kind: &'a str,
}

impl<'a> From<&'a EnrichedEvent> for LlmCallRow<'a> {
    fn from(e: &'a EnrichedEvent) -> Self {
        Self {
            org_id: e.org_id.as_str(),
            trace_id: e.event.trace_id.as_str(),
            span_id: e.event.span_id.as_str(),
            parent_span_id: e.event.parent_span_id.as_deref(),
            timestamp: e.event.timestamp as i64,
            latency_ms: e.event.latency_ms,
            ttft_ms: e.event.ttft_ms,
            model: e.event.model.as_str(),
            provider: e.event.provider.as_str(),
            input_tokens: e.event.input_tokens,
            output_tokens: e.event.output_tokens,
            cost_usd: e.event.cost_usd,
            // unwrap_or(0.0): unknown models leave these as None on the
            // EnrichedEvent. The ClickHouse column has DEFAULT 0 anyway,
            // but explicit beats implicit at the row-binding layer.
            input_cost_usd: e.event.input_cost_usd.unwrap_or(0.0),
            output_cost_usd: e.event.output_cost_usd.unwrap_or(0.0),
            status: e.event.status.as_str(),
            error_message: e.event.error_message.as_deref(),
            input_text: e.event.input_text.as_str(),
            output_text: e.event.output_text.as_str(),
            feature_name: e.event.feature_name.as_deref(),
            user_id: e.event.user_id.as_deref(),
            session_id: e.event.session_id.as_deref(),
            customer_id: e.event.customer_id.as_deref(),
            attempt_number: e.event.attempt_number,
            retry_reason: e.event.retry_reason.as_deref(),
            is_test: e.event.is_test,
            cache_read_cost_usd: e.event.cache_read_cost_usd.unwrap_or(0.0),
            // as_deref().unwrap_or("…"): the fallback is a 'static literal, so
            // the borrowed row still satisfies its lifetime when cost_source
            // is None (unknown model that the SDK didn't tag).
            cost_source: e.event.cost_source.as_deref().unwrap_or("unknown_model"),
            pricing_version: e.event.pricing_version.as_deref(),
            environment: e.event.environment.as_str(),
            sdk_version: e.event.sdk_version.as_str(),
            extra: e.event.extra.as_deref(),
            finish_reason: e.event.finish_reason.as_deref(),
            cache_read_tokens: e.event.cache_read_tokens,
            original_model: e.event.original_model.as_deref(),
            budget_state: e.event.budget_state.as_deref(),
            failure_mode: e.event.failure_mode.as_deref(),
            tool_calls: e.event.tool_calls.as_deref(),
            prompt_version: e.event.prompt_version.as_deref(),
            kind: e.event.kind.as_str(),
        }
    }
}

pub struct ClickHouseWriter {
    client: clickhouse::Client,
}

impl ClickHouseWriter {
    pub fn new(client: clickhouse::Client) -> Self {
        Self { client }
    }

    /// Insert a batch of events into `llm_calls`.
    ///
    /// Takes the events by shared slice, not by value: the caller (the
    /// consumer's `flush`, and the per-event retry path) keeps ownership so
    /// it can fall back to per-event retry + dead-lettering on failure
    /// without us having to clone the batch up front. Each `LlmCallRow`
    /// borrows from the slice for the duration of its single `write`, so the
    /// happy path performs no per-event allocation.
    pub async fn insert_batch(&self, events: &[EnrichedEvent]) -> anyhow::Result<()> {
        let mut inserter = self
            .client
            .insert("llm_calls")
            .context("creating ClickHouse inserter")?;

        for event in events {
            let row = LlmCallRow::from(event);
            inserter.write(&row).await.context("writing row")?;
        }

        inserter
            .end()
            .await
            .context("committing ClickHouse batch")?;
        debug!("ClickHouse batch committed");
        Ok(())
    }
}
