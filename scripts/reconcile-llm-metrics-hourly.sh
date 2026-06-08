#!/bin/sh
# Periodic reconcile of llm_metrics_hourly from raw llm_calls.
#
# Why this exists
# ---------------
# The processor is at-least-once: a crash in the narrow window between a
# successful ClickHouse write and the offset-file save replays the last
# batch on restart. The raw llm_calls table absorbs this cleanly — it is a
# ReplacingMergeTree on (org_id, timestamp, span_id), so a replayed row
# collapses into the original at merge time.
#
# The llm_metrics_hourly rollup does NOT get that protection. The
# llm_calls_to_metrics_mv materialized view fires once per INSERT and emits
# a partial-aggregate row; its additive columns are SimpleAggregateFunction(sum)
# (see 009_fix_rollup_additive_columns.sql), so a replayed batch is SUMMED on
# top of the original instead of being deduped. Net effect of a crash-replay:
# the rollup over-counts calls / cost / errors while raw stays correct.
#
# Because raw is the deduped source of truth and the rollup is fully
# reconstructable from it, the fix is not a fragile exactly-once write path
# but a periodic rebuild-from-raw that heals any drift. This script is that
# rebuild. It is idempotent and safe to run on a schedule.
#
# How it differs from backfill-llm-metrics-hourly.sh
# --------------------------------------------------
# - Reads `llm_calls FINAL` so unmerged ReplacingMergeTree duplicates are
#   collapsed before aggregation (the backfill script omits FINAL).
# - Swaps with EXCHANGE TABLES, not RENAME, so it leaves no _old table behind
#   and is safe to run repeatedly (RENAME → _old collides on the second run).
# - Inserts no probe row.
# backfill-llm-metrics-hourly.sh remains the one-time pre-migration-005
# upgrade tool; this script is the ongoing correctness safety net.
#
# In-flight window
# ----------------
# Rows that land in llm_calls WHILE the rebuild SELECT is scanning have their
# MV-emitted rollup rows written into the table that EXCHANGE swaps out, so
# they are dropped at the swap and under-represented in the rollup until the
# next reconcile picks them up from raw. The window is small and self-healing.
# For a zero-loss run, pause the processor for the duration, or schedule this
# at a low-traffic hour. (Scale-time refinement: rebuild only settled hour
# buckets and leave the current hour to the live MV.)
#
# Usage
# -----
#   # Against a running self-hosted stack (script runs as a file arg, so its
#   # stdin is free and clickhouse-client never mistakes it for INSERT data):
#   docker cp scripts/reconcile-llm-metrics-hourly.sh scopecall-clickhouse:/tmp/reconcile.sh
#   docker exec scopecall-clickhouse sh /tmp/reconcile.sh
#
#   # Or directly, with CH_HOST pointing at the server:
#   CH_HOST=localhost sh scripts/reconcile-llm-metrics-hourly.sh
#
#   # Schedule daily at 04:00 (cron on the ClickHouse host):
#   0 4 * * * docker cp /opt/scopecall/scripts/reconcile-llm-metrics-hourly.sh \
#       scopecall-clickhouse:/tmp/reconcile.sh && \
#       docker exec scopecall-clickhouse sh /tmp/reconcile.sh >> /var/log/scopecall-reconcile.log 2>&1

set -eu

CH_HOST="${CH_HOST:-clickhouse}"

# Every statement is passed as a single --query argument with stdin tied to
# /dev/null. No heredocs: that keeps the script safe to invoke either as a
# file arg or piped through `sh < script`, with no chance of clickhouse-client
# reading the rest of the script as INSERT VALUES data.
ch_query() {
    clickhouse-client --host "$CH_HOST" --query "$1" < /dev/null
}

echo "→ Building shadow table with the live llm_metrics_hourly schema…"
ch_query "DROP TABLE IF EXISTS llm_metrics_hourly_reconcile"
ch_query "CREATE TABLE llm_metrics_hourly_reconcile AS llm_metrics_hourly"

echo "→ Re-aggregating from llm_calls FINAL (kind='llm' only)…"
# Projection mirrors llm_calls_to_metrics_mv (005_kind_aware_rollup.sql)
# line-for-line. avgState/quantileState emit the AggregateFunction blobs the
# columns expect; count()/sum()/countIf() write plain values into the
# SimpleAggregateFunction(sum) columns (which store and read identically to
# the underlying type). Group-by mirror: (org_id, hour, model, provider,
# feature_name).
ch_query "INSERT INTO llm_metrics_hourly_reconcile
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
GROUP BY org_id, hour, model, provider, feature_name"

echo "→ Atomic swap (EXCHANGE) and cleanup…"
ch_query "EXCHANGE TABLES llm_metrics_hourly AND llm_metrics_hourly_reconcile"
ch_query "DROP TABLE IF EXISTS llm_metrics_hourly_reconcile"

echo "✓ llm_metrics_hourly reconciled from llm_calls FINAL (kind='llm')."
