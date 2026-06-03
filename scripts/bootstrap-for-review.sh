#!/usr/bin/env bash
# One-shot bring-up for external reviewers / first-time local testers.
#
# Brings the stack up from source (no GHCR pull), applies all ClickHouse
# migrations, and seeds an API key so the e2e test and SDK examples Just Work.
#
# Production self-hosted does NOT use this — operators create the first admin
# via the /setup web form. This script exists solely so reviewers can run
# scripts/e2e-test.sh without manual setup steps.
#
# Usage (from repo root):
#   bash scripts/bootstrap-for-review.sh
#
# Idempotent: re-running on an existing stack is safe — migrations use
# IF NOT EXISTS, seed uses ON CONFLICT DO NOTHING.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ─── Prereqs ─────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker required"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose v2 required"; exit 1; }

# ── .env: required for AUTH_SECRET + INTERNAL_API_KEY ────────────────────────
if [ ! -f infra/.env ]; then
    echo "→ Generating infra/.env from .env.example with fresh secrets…"
    cp infra/.env.example infra/.env
    echo "AUTH_SECRET=$(openssl rand -hex 32)"      >> infra/.env
    echo "INTERNAL_API_KEY=$(openssl rand -hex 32)" >> infra/.env
fi

# ─── 1. Build + start ────────────────────────────────────────────────────────
echo "→ Building + starting stack from source (this takes ~3 min on first run)…"
docker compose \
    -f infra/docker-compose.yml \
    -f infra/docker-compose.build.yml \
    up -d --build

# ─── 2. Wait for postgres + clickhouse healthy ───────────────────────────────
echo "→ Waiting for postgres + clickhouse to be healthy…"
until docker exec scopecall-postgres pg_isready -U scopecall -d scopecall >/dev/null 2>&1; do
    sleep 2
done
until docker exec scopecall-clickhouse clickhouse-client --query "SELECT 1" >/dev/null 2>&1; do
    sleep 2
done

# ─── 3. Apply every ClickHouse migration in order ────────────────────────────
# Hardcoding a list of migration files is the kind of thing that goes stale
# every time we add one — the round-5 reviewer caught this script still
# referencing 002 + 003 after we'd shipped 004 and 005. Glob the directory
# so any new migration auto-picks-up. Migrations are idempotent
# (IF NOT EXISTS / DROP+CREATE for views) so re-running is safe.
#
# Note: the dockerised `clickhouse-migrate` service runs the SAME loop on
# every `docker compose up` via scripts/run-ch-migrations.sh, so once that
# service is up this loop is technically redundant for fresh installs. It
# remains here for the rare case the operator runs the bootstrap against
# an existing stack the migration service hasn't drained yet.
echo "→ Applying ClickHouse migrations…"
for mig in schemas/clickhouse/*.sql; do
    name=$(basename "$mig")
    # 001_initial.sql is already mounted into docker-entrypoint-initdb.d
    # and ran on first init; re-applying its CREATE TABLE IF NOT EXISTS
    # is a no-op but produces noisy "already exists" output. Skip it.
    [ "$name" = "001_initial.sql" ] && continue
    echo "  → $name"
    # Round-7 review fix: do NOT swallow migration errors with `|| true`.
    # If a migration fails, the reviewer/operator must see it — silent
    # failures here previously masked the round-6 quoting hazard for a
    # full review cycle. We capture stderr to a temp, run the migration,
    # and surface any non-empty output as an error if the exit code is
    # non-zero. Benign idempotency messages (codes 57: TABLE_ALREADY_EXISTS
    # etc.) come back on exit 0 — those are filtered for noise only.
    if ! docker exec -i scopecall-clickhouse clickhouse-client --multiquery < "$mig" 2> /tmp/ch-mig.err; then
        echo "  ✗ migration $name failed:" >&2
        cat /tmp/ch-mig.err >&2
        exit 1
    fi
    # Print stderr only when it's non-empty AND the migration succeeded —
    # ClickHouse sometimes writes noisy "already exists" notices to stderr
    # on idempotent re-runs.
    if [ -s /tmp/ch-mig.err ]; then
        grep -v "^$" /tmp/ch-mig.err || true
    fi
done

# ─── 4. Seed dev org + API key ───────────────────────────────────────────────
# Production self-hosted creates the first admin via /setup; for review/e2e we
# need an API key the SDK can use BEFORE any UI flow. Hash matches
# infra/dev-seed/seed.sql so the e2e script's default SDK_API_KEY works.
echo "→ Seeding dev org + API key (sc_live_dev_000000000000000000)…"
docker exec -i scopecall-postgres psql -U scopecall -d scopecall <<'EOF' >/dev/null
INSERT INTO orgs (id, name)
VALUES ('org_dev', 'Dev Org')
ON CONFLICT DO NOTHING;

INSERT INTO api_keys (org_id, key_hash, name)
VALUES (
    'org_dev',
    encode(sha256('sc_live_dev_000000000000000000'::bytea), 'hex'),
    'review-bootstrap-key'
)
ON CONFLICT DO NOTHING;
EOF

# ─── 5. Resolve INTERNAL_API_KEY for the e2e test ────────────────────────────
INTERNAL_API_KEY=$(docker inspect scopecall-api \
    | grep INTERNAL_API_KEY \
    | head -1 \
    | sed 's/.*INTERNAL_API_KEY=\([^"]*\)".*/\1/')

# ─── 6. Build the TypeScript SDK so scripts/e2e-sdk-test.mjs can import it ──
# The real-SDK e2e test exercises the auto-flush path through the actual
# @scopecall/sdk dist. If the dist isn't built, the test fails with a
# "module not found" that's confusing for first-time reviewers.
if [ -d "sdks/typescript" ]; then
    echo "→ Building @scopecall/sdk dist for the SDK e2e test…"
    (cd sdks/typescript && \
        (npm ci --silent 2>/dev/null || npm install --silent) && \
        npm run build --silent) || echo "  (SDK build failed — skip scripts/e2e-sdk-test.mjs or fix the env)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
cat <<EOF

──────────────────────────────────────────────────────────────────────────
 Bootstrap complete. Services running:

   Ingest    http://localhost:8080  (Bearer sc_live_dev_000000000000000000)
   API       http://localhost:8081
   Dashboard http://localhost:3000

 To run the end-to-end tests:

   # Curl-driven (covers wire format, server pricing, workflow spans,
   # flow map, time range, prompt versions, offset durability).

   ORG_ID=org_dev \\
   SDK_API_KEY=sc_live_dev_000000000000000000 \\
   INTERNAL_API_KEY=$INTERNAL_API_KEY \\
   bash scripts/e2e-test.sh

   # Real-SDK driven (covers exporter auto-flush — the round-5 reviewer
   # caught that previous e2e tests bypassed the actual SDK and would
   # have missed an auto-flush regression).

   node scripts/e2e-sdk-test.mjs

 To tear everything down (including data volumes):

   docker compose -f infra/docker-compose.yml \\
                  -f infra/docker-compose.build.yml down -v
──────────────────────────────────────────────────────────────────────────
EOF
