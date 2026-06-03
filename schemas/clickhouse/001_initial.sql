-- ScopeCall ClickHouse DDL — source of truth for storage layout
-- Run with: clickhouse-client --multiquery < 001_initial.sql

-- llm_calls: one row per LLM API call
CREATE TABLE IF NOT EXISTS llm_calls (
    org_id          String,
    trace_id        String,
    span_id         String,
    parent_span_id  Nullable(String),
    timestamp       DateTime64(3, 'UTC'),
    latency_ms      UInt32,
    ttft_ms         Nullable(UInt32),
    model           LowCardinality(String),
    provider        LowCardinality(String),
    input_tokens    UInt32,
    output_tokens   UInt32,
    cost_usd        Float64,
    -- Cost components — input_cost_usd and output_cost_usd are computed at
    -- ingest from per-model pricing so the dashboard doesn't have to recompute
    -- at display time. cost_usd remains the authoritative billed total.
    input_cost_usd  Float64 DEFAULT 0,
    output_cost_usd Float64 DEFAULT 0,
    status          LowCardinality(String),
    error_message   Nullable(String),
    input_text      String,
    output_text     String,
    feature_name    LowCardinality(Nullable(String)),
    user_id         Nullable(String),
    session_id      Nullable(String),
    environment     LowCardinality(String),
    sdk_version     LowCardinality(String),
    extra           Nullable(String),
    -- Extended fields — nullable; populated by instrumentation in future releases
    finish_reason       LowCardinality(Nullable(String)),
    cache_read_tokens   Nullable(UInt32),
    original_model      LowCardinality(Nullable(String)),
    budget_state        LowCardinality(Nullable(String)),
    failure_mode        LowCardinality(Nullable(String)),
    tool_calls          Nullable(String)
) ENGINE = ReplacingMergeTree()
  PARTITION BY toYYYYMM(timestamp)
  ORDER BY (org_id, timestamp, span_id)
  TTL toDateTime(timestamp) + INTERVAL 90 DAY
  SETTINGS index_granularity = 8192;

-- llm_metrics_hourly: pre-aggregated rollup for dashboard charts
CREATE TABLE IF NOT EXISTS llm_metrics_hourly (
    org_id          String,
    hour            DateTime,
    model           LowCardinality(String),
    provider        LowCardinality(String),
    feature_name    LowCardinality(String),
    call_count      UInt64,
    total_cost_usd  Float64,
    avg_latency_ms  AggregateFunction(avg, Float64),
    p99_latency_ms  AggregateFunction(quantile(0.99), Float64),
    error_count     UInt64
) ENGINE = AggregatingMergeTree()
  PARTITION BY toYYYYMM(hour)
  ORDER BY (org_id, hour, model, feature_name)
  SETTINGS index_granularity = 8192;

-- Materialized view: populates llm_metrics_hourly from llm_calls inserts
CREATE MATERIALIZED VIEW IF NOT EXISTS llm_calls_to_metrics_mv
TO llm_metrics_hourly AS
SELECT
    org_id,
    toStartOfHour(timestamp)                    AS hour,
    model,
    provider,
    coalesce(feature_name, '')                  AS feature_name,
    count()                                     AS call_count,
    sum(cost_usd)                               AS total_cost_usd,
    avgState(toFloat64(latency_ms))             AS avg_latency_ms,
    quantileState(0.99)(toFloat64(latency_ms))  AS p99_latency_ms,
    countIf(status = 'error')                   AS error_count
FROM llm_calls
GROUP BY org_id, hour, model, provider, feature_name;

-- agent_traces: removed at v0.1.0. Agent-level tracing will be implemented
-- later as a materialized view over llm_calls (parent_span_id chains), not a
-- separate write target.
