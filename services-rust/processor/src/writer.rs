use anyhow::Context;
use clickhouse::Row;
use common::event::EnrichedEvent;
use serde::Serialize;
use tracing::debug;

/// ClickHouse row matching the llm_calls DDL in schemas/clickhouse/001_initial.sql.
#[derive(Debug, Row, Serialize)]
pub struct LlmCallRow {
    pub org_id: String,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    /// Milliseconds since Unix epoch → ClickHouse DateTime64(3)
    pub timestamp: i64,
    pub latency_ms: u32,
    pub ttft_ms: Option<u32>,
    pub model: String,
    pub provider: String,
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
    pub status: String,
    pub error_message: Option<String>,
    pub input_text: String,
    pub output_text: String,
    pub feature_name: Option<String>,
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    /// v0.3: B2B customer / tenant attribution. NULL for pre-v0.3 SDKs.
    /// Position matches migration 006 (added AFTER session_id).
    pub customer_id: Option<String>,
    /// v0.3: 1-based caller-attempt index. Default 1 for pre-v0.3 SDKs.
    /// Position matches migration 007.
    pub attempt_number: u16,
    /// v0.3: retry_reason closed enum. NULL on first attempt.
    pub retry_reason: Option<String>,
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
    pub cost_source: String,
    /// v0.3: pricing-table version that produced cost_usd. YYYY-MM-DD.
    pub pricing_version: Option<String>,
    pub environment: String,
    pub sdk_version: String,
    pub extra: Option<String>,
    pub finish_reason: Option<String>,
    pub cache_read_tokens: Option<u32>,
    pub original_model: Option<String>,
    pub budget_state: Option<String>,
    pub failure_mode: Option<String>,
    pub tool_calls: Option<String>,
    pub prompt_version: Option<String>,
    /// "llm" | "workflow" | "agent" | "step" — agent + step joined the
    /// closed set in v0.3 for cost rollups across the workflow → agent
    /// → step hierarchy. See schemas/clickhouse/004_span_kind.sql for
    /// the original column + the v0.3 migrations that expanded the enum.
    pub kind: String,
}

impl From<EnrichedEvent> for LlmCallRow {
    fn from(e: EnrichedEvent) -> Self {
        Self {
            org_id: e.org_id,
            trace_id: e.event.trace_id,
            span_id: e.event.span_id,
            parent_span_id: e.event.parent_span_id,
            timestamp: e.event.timestamp as i64,
            latency_ms: e.event.latency_ms,
            ttft_ms: e.event.ttft_ms,
            model: e.event.model,
            provider: e.event.provider,
            input_tokens: e.event.input_tokens,
            output_tokens: e.event.output_tokens,
            cost_usd: e.event.cost_usd,
            // unwrap_or(0.0): unknown models leave these as None on the
            // EnrichedEvent. The ClickHouse column has DEFAULT 0 anyway,
            // but explicit beats implicit at the row-binding layer.
            input_cost_usd: e.event.input_cost_usd.unwrap_or(0.0),
            output_cost_usd: e.event.output_cost_usd.unwrap_or(0.0),
            status: e.event.status,
            error_message: e.event.error_message,
            input_text: e.event.input_text,
            output_text: e.event.output_text,
            feature_name: e.event.feature_name,
            user_id: e.event.user_id,
            session_id: e.event.session_id,
            customer_id: e.event.customer_id,
            attempt_number: e.event.attempt_number,
            retry_reason: e.event.retry_reason,
            is_test: e.event.is_test,
            cache_read_cost_usd: e.event.cache_read_cost_usd.unwrap_or(0.0),
            cost_source: e.event.cost_source.unwrap_or_else(|| "unknown_model".to_owned()),
            pricing_version: e.event.pricing_version,
            environment: e.event.environment,
            sdk_version: e.event.sdk_version,
            extra: e.event.extra,
            finish_reason: e.event.finish_reason,
            cache_read_tokens: e.event.cache_read_tokens,
            original_model: e.event.original_model,
            budget_state: e.event.budget_state,
            failure_mode: e.event.failure_mode,
            tool_calls: e.event.tool_calls,
            prompt_version: e.event.prompt_version,
            kind: e.event.kind,
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

    pub async fn insert_batch(&self, events: Vec<EnrichedEvent>) -> anyhow::Result<()> {
        let mut inserter = self
            .client
            .insert("llm_calls")
            .context("creating ClickHouse inserter")?;

        for event in events {
            let row: LlmCallRow = event.into();
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
