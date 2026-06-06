-- Rewrite the llm_calls → llm_metrics_hourly materialized view so it
-- aggregates ONLY rows where kind = 'llm'.
--
-- Why this exists
-- ---------------
-- Migration 004 added kind ('llm' | 'workflow') to llm_calls. sdk.trace()
-- now writes one synthetic workflow row per block. The hourly rollup MV
-- defined in 001 has no kind filter, so workflow rows were:
--   - inflating call_count (1 workflow + N llm = N+1 "calls")
--   - skewing avg_latency (workflow latency = full block duration)
--   - skewing p99_latency
--   - adding to error_count when the trace block threw
--   - adding to total_cost_usd as 0 (the only one that's harmless)
--
-- Every cost / latency / error chart and the Overview page read from this
-- view. Without the filter, those numbers were lies as soon as users
-- started using sdk.trace().
--
-- ClickHouse can't ALTER MATERIALIZED VIEW's SELECT in place — DROP +
-- CREATE is the only path. Both statements use IF EXISTS / IF NOT EXISTS
-- so the migration is idempotent.

DROP VIEW IF EXISTS llm_calls_to_metrics_mv;

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
WHERE kind = 'llm'
GROUP BY org_id, hour, model, provider, feature_name;

-- NOTE: this rewrites the VIEW DEFINITION. It does NOT rewrite the
-- llm_metrics_hourly table content that the broken MV already produced.
-- Backfill is a separate ops step:
--
--   TRUNCATE TABLE llm_metrics_hourly;
--   INSERT INTO llm_metrics_hourly
--     SELECT … FROM llm_calls WHERE kind = 'llm' GROUP BY …;
--
-- We deliberately don't do that here because:
--   (a) on fresh installs there's nothing to backfill,
--   (b) on existing installs the operator should decide whether the
--       polluted historical data is acceptable or needs replay.
-- The Overview/charts will self-correct from the next hour onward.
