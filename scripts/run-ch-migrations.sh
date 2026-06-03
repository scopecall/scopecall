#!/bin/sh
# Applies every schemas/clickhouse/*.sql in alphabetical order via
# clickhouse-client. Run by the scopecall-ch-migrate compose service after
# ClickHouse becomes healthy.
#
# Round-7 review caught that an earlier version of this loop re-ran every
# .sql on every `docker compose up`. The migrations are idempotent
# (CREATE / ALTER … IF [NOT] EXISTS, DROP+CREATE for views), but some of
# them — specifically the index materializations in 002_trace_id_skip_index.sql
# and 004_span_kind.sql — kick off ClickHouse mutations that scan the
# whole `llm_calls` table. On a small dev table that's invisible; on a
# multi-billion-row production table it's a meaningful cost on every boot.
#
# Fix: a tiny self-tracking table records which migrations have already
# run, and we skip them. The marker table is created on first run with
# the same idempotent IF NOT EXISTS pattern as every other migration, so
# it back-fills harmlessly into existing installs.
#
# Migration filename is the natural primary key — alphabetical order is
# the deployment contract for this codebase, and filenames never change
# after release. If a migration needs to re-run (e.g. to backfill a new
# column), bump the filename and rely on the tracker treating it as a
# fresh entry.
#
# Lives as a real shell script (not inline in docker-compose.yml) because
# YAML's quoting / folded-scalar / block-scalar rules make it easy to ship
# a `command:` that silently parses as an argv list of words rather than
# one shell script. Round-5 reviewer flagged the previous inline form;
# moving it to a file eliminates the whole class of mis-parses.

set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
CH_HOST="${CH_HOST:-clickhouse}"

ch() {
    clickhouse-client --host "$CH_HOST" "$@"
}

# Create the tracker if it doesn't exist. ReplacingMergeTree on a single-
# row-per-name primary key gives us upsert semantics without explicit
# transactions — re-running this CREATE is a no-op.
ch --query "
CREATE TABLE IF NOT EXISTS _scopecall_migrations (
    name       String,
    applied_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree()
ORDER BY name
"

for m in "$MIGRATIONS_DIR"/*.sql; do
    name=$(basename "$m")
    # Skip if already recorded. We use `FINAL` here because the tracker
    # ReplacingMergeTree may have unmerged duplicates from a prior
    # restart — FINAL collapses them at read time. The table is tiny
    # (one row per migration), so FINAL cost is negligible.
    applied=$(ch --query "SELECT count() FROM _scopecall_migrations FINAL WHERE name = '$name'")
    if [ "$applied" != "0" ]; then
        echo "✓ $name (already applied)"
        continue
    fi
    echo "→ applying $name"
    ch --multiquery < "$m"
    ch --query "INSERT INTO _scopecall_migrations (name) VALUES ('$name')"
done

echo "✓ all ClickHouse migrations applied"
