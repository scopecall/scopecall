-- CRITICAL correctness fix for the llm_metrics_hourly rollup.
--
-- Root cause
-- ----------
-- llm_metrics_hourly is an AggregatingMergeTree, but call_count,
-- total_cost_usd, and error_count were declared as PLAIN UInt64/Float64
-- (see 001_initial.sql). AggregatingMergeTree only *combines* columns of
-- type AggregateFunction / SimpleAggregateFunction when it collapses rows
-- that share the ORDER BY key. PLAIN columns are NOT summed — the merge
-- keeps one arbitrary surviving row's value and discards the rest.
--
-- The MV (llm_calls_to_metrics_mv) emits ONE partial-aggregate row per
-- (org_id, hour, model, provider, feature_name) PER INSERT BATCH. In normal
-- operation many batches contribute to the same hourly group, so the table
-- accumulates many same-key rows. As background merges collapse them, every
-- batch's count/cost/errors EXCEPT one is silently discarded. Net effect:
-- the rollup UNDERCOUNTS, and drifts further down as merges run. The latency
-- columns (avg_latency_ms / p99_latency_ms) were always correct because they
-- are AggregateFunction and compose losslessly.
--
-- Verified on dev data before this migration: rollup reported 566 calls /
-- $2.5975 vs raw ground truth 708 calls / $2.9552 — a 20% / 12% undercount,
-- with the partition fully merged to a single part (settled, not transient).
--
-- Fix
-- ---
-- (1) Retype the three additive columns to SimpleAggregateFunction(sum, T).
--     SimpleAggregateFunction(sum, T) is stored identically to T on disk, so
--     this is an in-place metadata ALTER (no part rewrite). After it, merges
--     sum these columns correctly. The MV SELECT (count()/sum()/countIf) and
--     the Go read path (sum(call_count) / sum(total_cost_usd) / sum(error_count))
--     are UNCHANGED — SimpleAggregateFunction(sum, T) reads and writes as T.
--
-- (2) Rebuild already-corrupted history from raw, deduplicated ground truth.
--     Past merges permanently dropped summands, so step (1) alone only fixes
--     the future. We rebuild into a shadow table and atomically EXCHANGE so
--     the live table stays readable until the instant of the swap.
--
-- Rollout note: rollup rows the live MV writes into the OLD table DURING the
-- rebuild scan are discarded at EXCHANGE. For a zero-loss rollout, pause the
-- processor for the duration of this migration. The raw llm_calls table is
-- the source of truth and is untouched here; the rollup is fully
-- reconstructable from it at any time — which is exactly the property this
-- migration restores.

-- (1) In-place retype. Idempotent: MODIFY COLUMN to the same type is a no-op.
ALTER TABLE llm_metrics_hourly
    MODIFY COLUMN call_count     SimpleAggregateFunction(sum, UInt64),
    MODIFY COLUMN total_cost_usd SimpleAggregateFunction(sum, Float64),
    MODIFY COLUMN error_count    SimpleAggregateFunction(sum, UInt64);

-- (2) Rebuild history from raw ground truth into a shadow with the corrected
-- schema, then swap atomically. DROP IF EXISTS guards make a re-run safe if a
-- prior attempt failed before recording in _scopecall_migrations.
DROP TABLE IF EXISTS llm_metrics_hourly_rebuild;
CREATE TABLE llm_metrics_hourly_rebuild AS llm_metrics_hourly;

INSERT INTO llm_metrics_hourly_rebuild
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
FROM llm_calls FINAL
WHERE kind = 'llm'
GROUP BY org_id, hour, model, provider, feature_name;

EXCHANGE TABLES llm_metrics_hourly AND llm_metrics_hourly_rebuild;
DROP TABLE IF EXISTS llm_metrics_hourly_rebuild;
