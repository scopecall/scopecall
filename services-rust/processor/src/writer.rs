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
    // are 0 and `cost_usd` falls back to the SDK-supplied value. Column
    // order MUST match the ClickHouse DDL in schemas/clickhouse/001_initial.sql
    // because the clickhouse-rs client uses positional binding.
    pub input_cost_usd: f64,
    pub output_cost_usd: f64,
    pub status: String,
    pub error_message: Option<String>,
    pub input_text: String,
    pub output_text: String,
    pub feature_name: Option<String>,
    pub user_id: Option<String>,
    pub session_id: Option<String>,
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
    /// "llm" | "workflow" — see schemas/clickhouse/004_span_kind.sql.
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
