#!/bin/sh
# Backfill llm_metrics_hourly for upgrade installs.
#
# Why this exists
# ---------------
# Round-4 review identified that the llm_metrics_hourly materialized view
# was aggregating BOTH kind='llm' and kind='workflow' rows, polluting the
# per-hour aggregates with zero-cost / zero-token workflow spans (which
# inflated call_count, skewed avg/p99 latency, and could nudge error_count).
# Migration 005_kind_aware_rollup.sql fixes the MV definition going forward,
# but rows already in the rollup from Rounds 4 and 5 stay wrong until
# they're rebuilt.
#
# This script does the rebuild: drop the existing aggregates, re-aggregate
# from the source llm_calls table with the kind='llm' filter that the new
# MV uses.
#
# When to run
# -----------
# - Before onboarding the first design partner who'd see polluted
#   historical metrics older than the rollup horizon on the cost / latency /
#   throughput charts.
# - On any environment that ran ScopeCall pre-migration-005.
# - Skip on fresh installs: the new MV is correct from the first event.
#
# Safety
# ------
# - Reads CH_HOST env var; defaults to `clickhouse` (the compose service name).
#   Run via `docker exec` inside scopecall-clickhouse for the standard
#   self-hosted stack, or set CH_HOST=localhost when invoking the script
#   from outside the container.
# - Uses a swap-table dance (DROP + CREATE _new with the same schema as the
#   original) so there's no window where llm_metrics_hourly is empty and
#   the dashboard shows "no data" for the whole history. The swap is a
#   single atomic RENAME pair.
# - Source rows in llm_calls are untouched.
# - The old table is preserved as llm_metrics_hourly_old so the operator
#   can verify the rebuilt aggregates before dropping it.
#
# Schema awareness
# ----------------
# llm_metrics_hourly uses AggregateFunction columns (avg, quantile). The
# original MV writes -State() encoded values; a straight INSERT … SELECT
# from llm_calls must match that contract or the INSERT silently fails
# (type mismatch) — earlier versions of this script did exactly that and
# the Round-8 reviewer correctly flagged it. The query below mirrors the
# MV's projection in 005_kind_aware_rollup.sql line-for-line:
#
#     count()                                      → call_count
#     sum(cost_usd)                                → total_cost_usd
#     avgState(toFloat64(latency_ms))              → avg_latency_ms
#     quantileState(0.99)(toFloat64(latency_ms))   → p99_latency_ms
#     countIf(status = 'error')                    → error_count
#
# Group-by mirror: (org_id, hour, model, provider, feature_name).
#
# Usage
# -----
#   # Against a running self-hosted stack:
#   docker exec scopecall-clickhouse /bin/sh < scripts/backfill-llm-metrics-hourly.sh
#
#   # Or directly with CH_HOST set:
#   CH_HOST=localhost sh scripts/backfill-llm-metrics-hourly.sh

set -eu

CH_HOST="${CH_HOST:-clickhouse}"

ch() {
    clickhouse-client --host "$CH_HOST" "$@"
}

# ch_query is for one-off --query calls. clickhouse-client reads stdin
# for INSERT data by default, and when this script is invoked via
# `docker exec ... /bin/sh < this-script.sh` the script itself comes in
# through stdin — so an unguarded --query INSERT would interpret the
# rest of the script as VALUES data. Redirecting from /dev/null makes
# the call truly stdin-less. Heredoc-driven calls keep using ch() so
# the heredoc body still reaches clickhouse-client as expected.
ch_query() {
    clickhouse-client --host "$CH_HOST" --query "$1" < /dev/null
}

echo "→ Creating scratch rollup table with the same schema as llm_metrics_hourly…"
ch --multiquery <<'SQL'
DROP TABLE IF EXISTS llm_metrics_hourly_new;

CREATE TABLE llm_metrics_hourly_new AS llm_metrics_hourly;
SQL

echo "→ Re-aggregating from llm_calls (kind='llm' only)…"
# The State() functions emit binary aggregate-state blobs that match the
# llm_metrics_hourly column types — the same shape the MV produces. A
# regular avg() / quantile() here would write Float64 scalars into
# AggregateFunction columns and ClickHouse would reject the INSERT.
ch --multiquery <<'SQL'
INSERT INTO llm_metrics_hourly_new
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
SQL

echo "→ Row counts before/after, for the operator's records:"
ch_query "SELECT 'old' AS table, count() FROM llm_metrics_hourly UNION ALL SELECT 'new', count() FROM llm_metrics_hourly_new"

echo "→ Atomic rename swap…"
ch --multiquery <<'SQL'
RENAME TABLE
    llm_metrics_hourly     TO llm_metrics_hourly_old,
    llm_metrics_hourly_new TO llm_metrics_hourly;
SQL

# ────────────────────────────────────────────────────────────────────────
# Post-swap MV verification (Round-9 review).
#
# The materialized view llm_calls_to_metrics_mv was created with
# `TO default.llm_metrics_hourly` (a textual name). After a RENAME TABLE
# in a default-Atomic database, ClickHouse resolves that name at insert
# time — so new inserts SHOULD flow into the renamed table. But CH binding
# behavior varies by database engine and version, and "I assumed it works"
# was the exact failure pattern the reviewer asked us to stop doing.
#
# We prove it: insert a synthetic probe row into llm_calls and confirm it
# lands in the active llm_metrics_hourly (not llm_metrics_hourly_old). If
# the assertion fails, the MV is bound to the wrong identity and the
# operator needs to DROP + CREATE it before continuing.
#
# The probe row has feature_name='_backfill_verify' so it's trivially
# filterable out of any dashboard view. We deliberately do NOT delete it
# afterwards — CH mutations on llm_calls are expensive at scale, and one
# extra row in 460M is invisible. The operator can ALTER TABLE DELETE it
# if they care.
echo "→ Verifying MV target after swap (insert probe → check rollup)…"
PROBE_TRACE="_backfill_verify_$(date +%s)"
# Use --query (not a heredoc) so the script can be invoked via
# `docker exec ... /bin/sh < this-script.sh`. In that mode the script
# itself comes through stdin, so any nested heredoc inside the script
# fights for the same fd. `--query` takes the SQL as a single argv string
# and sidesteps the conflict.
ch_query "INSERT INTO llm_calls (org_id, trace_id, span_id, parent_span_id, timestamp, latency_ms, ttft_ms, model, provider, input_tokens, output_tokens, cost_usd, status, error_message, input_text, output_text, feature_name, user_id, session_id, environment, sdk_version, extra, finish_reason, cache_read_tokens, original_model, budget_state, failure_mode, tool_calls, prompt_version, kind, input_cost_usd, output_cost_usd) VALUES ('_backfill_verify_org', '${PROBE_TRACE}', '${PROBE_TRACE}-span', NULL, now(), 1, NULL, '_backfill_verify_model', 'openai', 1, 1, 0.0, 'success', NULL, '', '', '_backfill_verify', NULL, NULL, 'test', '0.1.1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'llm', 0.0, 0.0)"

# Give the MV a moment to flush. CH's MV chain is synchronous inside a
# single insert, but defensive sleep covers any background coalescing.
sleep 2

ACTIVE_COUNT=$(ch_query "SELECT count() FROM llm_metrics_hourly      WHERE model='_backfill_verify_model'")
OLD_COUNT=$(ch_query    "SELECT count() FROM llm_metrics_hourly_old  WHERE model='_backfill_verify_model'")

if [ "$ACTIVE_COUNT" = "1" ] && [ "$OLD_COUNT" = "0" ]; then
    echo "  ✓ MV verification passed (active=1, old=0) — new inserts route to active rollup"
elif [ "$ACTIVE_COUNT" = "0" ] && [ "$OLD_COUNT" = "1" ]; then
    echo "  ✗ MV verification FAILED — new inserts still route to llm_metrics_hourly_old."
    echo "  The materialized view is bound to the pre-rename identity."
    echo "  Recover with:"
    echo "    DROP VIEW IF EXISTS llm_calls_to_metrics_mv;"
    echo "    -- then re-apply schemas/clickhouse/005_kind_aware_rollup.sql"
    echo "  Your rollup is intact (the backfilled rows are in active), but"
    echo "  ongoing inserts won't update it until the MV is recreated."
    exit 1
else
    echo "  ✗ MV verification inconclusive (active=$ACTIVE_COUNT, old=$OLD_COUNT)."
    echo "  Inspect manually before relying on the new rollup."
    exit 1
fi

echo "→ Backfill complete."
echo "  llm_metrics_hourly now reflects kind='llm' rows only."
echo "  llm_metrics_hourly_old is retained for rollback / spot-checking."
echo "  A probe row was inserted into llm_calls with feature_name=_backfill_verify"
echo "  (one row total; filter it out of dashboards or DELETE manually)."
echo "  To reclaim space (after verifying the new rollup):"
echo "      DROP TABLE llm_metrics_hourly_old;"
echo "  We recommend leaving it for a day or two before dropping."
