#!/usr/bin/env bash
# End-to-end smoke test for the post-external-review P0+P1 work.
#
# Exercises against the running docker-compose stack:
#   1. Wire format (TS-SDK shape: timestamp number, sent_at snake_case,
#      trace_id non-null) → ingest returns 200.
#   2. Old wire format (timestamp as ISO string) → ingest returns 400.
#      Confirms the previous behaviour really WAS broken and our fix matters.
#   3. prompt_version end-to-end: SDK → ingest → processor → CH → /api/v1/prompts.
#   4. Server-side pricing: SDK-supplied cost_usd=999.99 → processor overwrites
#      with the canonical pricing.json value.
#   5. Drill-in time range: three events at staggered timestamps → /api/v1/traces
#      with narrow ?from=&to= returns only the middle event.
#
# Requires the stack running:
#   docker compose -f infra/docker-compose.yml \
#                  -f infra/docker-compose.build.yml up -d
# And the CH migration applied:
#   docker exec -i scopecall-clickhouse clickhouse-client --multiquery \
#     < schemas/clickhouse/003_prompt_version.sql

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
INGEST_URL="${INGEST_URL:-http://localhost:8080/v1/ingest}"
API_URL="${API_URL:-http://localhost:8081}"
CH_URL="${CH_URL:-http://localhost:8123}"

# Dev API key — see infra/dev-seed/seed.sql. SHA-256 hash of this is in api_keys.
SDK_API_KEY="${SDK_API_KEY:-sc_live_dev_000000000000000000}"
ORG_ID="${ORG_ID:-org_dev}"

# Internal API key — read from running api container env on bring-up.
# Allows the test script to authenticate to the dashboard API without a JWT.
# Falls back to the value embedded by infra/.env on a fresh deploy.
INTERNAL_API_KEY="${INTERNAL_API_KEY:-}"
if [ -z "$INTERNAL_API_KEY" ]; then
    INTERNAL_API_KEY=$(docker inspect scopecall-api 2>/dev/null \
        | grep INTERNAL_API_KEY \
        | head -1 \
        | sed 's/.*INTERNAL_API_KEY=\([^"]*\)".*/\1/')
fi
if [ -z "$INTERNAL_API_KEY" ]; then
    echo "ERROR: could not resolve INTERNAL_API_KEY; set it explicitly" >&2
    exit 1
fi

# ─── Output helpers ──────────────────────────────────────────────────────────
PASS=0
FAIL=0
RESULTS=()

pass() {
    PASS=$((PASS+1))
    RESULTS+=("PASS: $1")
    printf "\033[32m✓\033[0m %s\n" "$1"
}

fail() {
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL: $1 -- $2")
    printf "\033[31m✗\033[0m %s\n    %s\n" "$1" "$2"
}

api_get() {
    # Calls the API with internal-key auth as an OWNER of org_dev so we can
    # read traces with content + extra fields. Matches the trusted-proxy
    # contract in services-go/.../middleware/auth.go.
    curl -fsS -H "x-internal-key: $INTERNAL_API_KEY" \
              -H "x-org-id: $ORG_ID" \
              -H "x-user-id: e2e-test-user" \
              -H "x-user-role: owner" \
              "$@"
}

ch_query() {
    # ClickHouse direct access via docker exec — the CH container exposes its
    # HTTP port only on the docker network, not the host, so curl from the
    # host can't reach it. exec runs the client inside the container.
    # `--query="$1"` is escaped per-argument by docker exec; safe with any
    # quoting because we never pass user input here (test fixtures only).
    docker exec scopecall-clickhouse clickhouse-client --query="$1"
}

# Random hex so concurrent runs don't collide.
SUFFIX=$(head -c 8 /dev/urandom | xxd -p)
NOW_MS=$(($(date +%s)*1000))

# ─── 1. Wire format — new shape (must be 200) ────────────────────────────────
TEST_NAME="wire-format-new (timestamp number, snake_case sent_at, non-null trace_id)"
SPAN_ID="span_wire_${SUFFIX}"
TRACE_ID="trace_wire_${SUFFIX}"
BODY=$(cat <<EOF
{
  "events": [{
    "span_id": "$SPAN_ID",
    "trace_id": "$TRACE_ID",
    "parent_span_id": null,
    "timestamp": $NOW_MS,
    "latency_ms": 50,
    "ttft_ms": null,
    "model": "gpt-4o",
    "provider": "openai",
    "input_tokens": 100,
    "output_tokens": 50,
    "cost_usd": 0.001,
    "status": "success",
    "error_message": null,
    "input_text": "wire format test",
    "output_text": "ok",
    "feature_name": "e2e-wire",
    "user_id": null,
    "session_id": null,
    "environment": "test",
    "sdk_version": "e2e-0.0.0",
    "extra": null,
    "finish_reason": "stop",
    "cache_read_tokens": null,
    "original_model": null,
    "budget_state": null,
    "failure_mode": null,
    "tool_calls": null,
    "prompt_version": null
  }],
  "sent_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
HTTP_CODE=$(curl -sS -o /tmp/e2e-wire-new.body -w "%{http_code}" \
    -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $SDK_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "202" ] || [ "$HTTP_CODE" = "204" ]; then
    pass "$TEST_NAME"
else
    fail "$TEST_NAME" "expected 2xx, got $HTTP_CODE: $(cat /tmp/e2e-wire-new.body)"
fi

# ─── 2. Wire format — old shape (must be 400) ────────────────────────────────
TEST_NAME="wire-format-old (timestamp as ISO string) → ingest rejects"
BODY_OLD=$(cat <<EOF
{
  "events": [{
    "span_id": "span_old_${SUFFIX}",
    "trace_id": "trace_old_${SUFFIX}",
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "latency_ms": 50,
    "model": "gpt-4o",
    "provider": "openai",
    "input_tokens": 100,
    "output_tokens": 50,
    "cost_usd": 0.001,
    "status": "success",
    "input_text": "old wire",
    "output_text": "ok",
    "environment": "test",
    "sdk_version": "e2e-0.0.0"
  }],
  "sentAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
HTTP_CODE=$(curl -sS -o /tmp/e2e-wire-old.body -w "%{http_code}" \
    -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $SDK_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY_OLD")
if [ "$HTTP_CODE" = "400" ]; then
    pass "$TEST_NAME"
else
    fail "$TEST_NAME" "expected 400, got $HTTP_CODE (the old format should not be accepted): $(cat /tmp/e2e-wire-old.body)"
fi

# ─── 3. prompt_version end-to-end ────────────────────────────────────────────
TEST_NAME="prompt_version: SDK → ingest → CH → /api/v1/prompts"
VERSION="e2e-v-${SUFFIX}"
SPAN_ID="span_pv_${SUFFIX}"
TRACE_ID="trace_pv_${SUFFIX}"
BODY=$(cat <<EOF
{
  "events": [{
    "span_id": "$SPAN_ID",
    "trace_id": "$TRACE_ID",
    "timestamp": $NOW_MS,
    "latency_ms": 100,
    "model": "gpt-4o",
    "provider": "openai",
    "input_tokens": 200,
    "output_tokens": 80,
    "cost_usd": 0.002,
    "status": "success",
    "input_text": "prompt version test",
    "output_text": "ok",
    "environment": "test",
    "sdk_version": "e2e-0.0.0",
    "prompt_version": "$VERSION"
  }],
  "sent_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
INGEST_CODE=$(curl -sS -o /tmp/e2e-pv.body -w "%{http_code}" \
    -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $SDK_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY")

# Wait for the processor to drain the batch (50ms flush + ClickHouse insert).
# 3 seconds is generous; the processor's PROCESSOR_FLUSH_INTERVAL_MS default
# is 500ms.
sleep 3

if [ "$INGEST_CODE" != "200" ] && [ "$INGEST_CODE" != "202" ] && [ "$INGEST_CODE" != "204" ]; then
    fail "$TEST_NAME" "ingest rejected ($INGEST_CODE): $(cat /tmp/e2e-pv.body)"
else
    # Query CH directly first — fastest way to confirm storage.
    COUNT=$(ch_query "SELECT count() FROM llm_calls WHERE prompt_version = '$VERSION'")
    if [ "$COUNT" != "1" ]; then
        fail "$TEST_NAME" "expected 1 CH row with prompt_version=$VERSION; got $COUNT"
    else
        # Then verify it surfaces via /api/v1/prompts.
        FROM=$(date -u -v -1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)
        TO=$(date -u -v +1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)
        PROMPTS=$(api_get "$API_URL/api/v1/prompts?org_id=$ORG_ID&from=$FROM&to=$TO" || echo '{"rows":[]}')
        FOUND=$(echo "$PROMPTS" | grep -c "\"version\":\"$VERSION\"" || true)
        if [ "$FOUND" -ge 1 ]; then
            pass "$TEST_NAME"
        else
            fail "$TEST_NAME" "/api/v1/prompts did not return prompt_version=$VERSION. Response: $PROMPTS"
        fi
    fi
fi

# ─── 4. Server-side pricing overrides SDK-supplied cost ──────────────────────
TEST_NAME="server-side pricing: SDK cost_usd=999.99 → CH stores recomputed value"
SPAN_ID="span_pricing_${SUFFIX}"
TRACE_ID="trace_pricing_${SUFFIX}"
# 1000 input + 1000 output @ gpt-4o pricing ($0.0025 in, $0.01 out per 1k)
# Expected total = 0.0125. SDK ships 999.99 as the "poison" value to detect.
BODY=$(cat <<EOF
{
  "events": [{
    "span_id": "$SPAN_ID",
    "trace_id": "$TRACE_ID",
    "timestamp": $NOW_MS,
    "latency_ms": 100,
    "model": "gpt-4o",
    "provider": "openai",
    "input_tokens": 1000,
    "output_tokens": 1000,
    "cost_usd": 999.99,
    "status": "success",
    "input_text": "pricing test",
    "output_text": "ok",
    "environment": "test",
    "sdk_version": "e2e-0.0.0"
  }],
  "sent_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
INGEST_CODE=$(curl -sS -o /tmp/e2e-pricing.body -w "%{http_code}" \
    -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $SDK_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY")
sleep 3

if [ "$INGEST_CODE" != "200" ] && [ "$INGEST_CODE" != "202" ] && [ "$INGEST_CODE" != "204" ]; then
    fail "$TEST_NAME" "ingest rejected ($INGEST_CODE): $(cat /tmp/e2e-pricing.body)"
else
    STORED=$(ch_query "SELECT cost_usd, input_cost_usd, output_cost_usd FROM llm_calls WHERE span_id = '$SPAN_ID' FORMAT TSV")
    # Expected: cost_usd ≈ 0.0125 (NOT 999.99), input_cost_usd = 0.0025, output_cost_usd = 0.01
    EXPECTED_TOTAL="0.0125"
    GOT_TOTAL=$(echo "$STORED" | awk -F'\t' '{print $1}')
    GOT_IN=$(echo "$STORED" | awk -F'\t' '{print $2}')
    GOT_OUT=$(echo "$STORED" | awk -F'\t' '{print $3}')
    if [ "$GOT_TOTAL" = "$EXPECTED_TOTAL" ] && [ "$GOT_IN" = "0.0025" ] && [ "$GOT_OUT" = "0.01" ]; then
        pass "$TEST_NAME (total=$GOT_TOTAL in=$GOT_IN out=$GOT_OUT)"
    elif [ "$GOT_TOTAL" = "999.99" ]; then
        fail "$TEST_NAME" "SDK cost_usd=999.99 was NOT overwritten — server-side pricing isn't running"
    else
        fail "$TEST_NAME" "expected total=$EXPECTED_TOTAL in=0.0025 out=0.01, got total=$GOT_TOTAL in=$GOT_IN out=$GOT_OUT"
    fi
fi

# ─── 5. Drill-in time range — only middle event returned ─────────────────────
TEST_NAME="drill-in time range: ?from=&to= filters precisely"
TS_OLD=$((NOW_MS - 3600000))   # 1h ago
TS_MID=$((NOW_MS - 1800000))   # 30min ago
TS_NEW=$((NOW_MS - 60000))     # 1min ago
SPAN_OLD="span_range_old_${SUFFIX}"
SPAN_MID="span_range_mid_${SUFFIX}"
SPAN_NEW="span_range_new_${SUFFIX}"
BODY=$(cat <<EOF
{
  "events": [
    { "span_id": "$SPAN_OLD", "trace_id": "trace_r_${SUFFIX}_a", "timestamp": $TS_OLD, "latency_ms": 1, "model": "gpt-4o", "provider": "openai", "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.0, "status": "success", "input_text": "old", "output_text": "x", "environment": "test", "sdk_version": "e2e-0.0.0" },
    { "span_id": "$SPAN_MID", "trace_id": "trace_r_${SUFFIX}_b", "timestamp": $TS_MID, "latency_ms": 1, "model": "gpt-4o", "provider": "openai", "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.0, "status": "success", "input_text": "mid", "output_text": "x", "environment": "test", "sdk_version": "e2e-0.0.0" },
    { "span_id": "$SPAN_NEW", "trace_id": "trace_r_${SUFFIX}_c", "timestamp": $TS_NEW, "latency_ms": 1, "model": "gpt-4o", "provider": "openai", "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.0, "status": "success", "input_text": "new", "output_text": "x", "environment": "test", "sdk_version": "e2e-0.0.0" }
  ],
  "sent_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
INGEST_CODE=$(curl -sS -o /tmp/e2e-range.body -w "%{http_code}" \
    -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $SDK_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY")
sleep 3

if [ "$INGEST_CODE" != "200" ] && [ "$INGEST_CODE" != "202" ] && [ "$INGEST_CODE" != "204" ]; then
    fail "$TEST_NAME" "ingest rejected ($INGEST_CODE): $(cat /tmp/e2e-range.body)"
else
    # Narrow window: 40min..20min ago should include only $TS_MID.
    FROM_MS=$((NOW_MS - 2400000))   # 40 min ago
    TO_MS=$((NOW_MS - 1200000))     # 20 min ago
    # Format as ISO 8601 — what /api/v1/traces expects.
    FROM_ISO=$(python3 -c "import datetime; print(datetime.datetime.utcfromtimestamp($FROM_MS / 1000).strftime('%Y-%m-%dT%H:%M:%SZ'))" 2>/dev/null || \
               date -u -r $((FROM_MS/1000)) +%Y-%m-%dT%H:%M:%SZ)
    TO_ISO=$(python3 -c "import datetime; print(datetime.datetime.utcfromtimestamp($TO_MS / 1000).strftime('%Y-%m-%dT%H:%M:%SZ'))" 2>/dev/null || \
             date -u -r $((TO_MS/1000)) +%Y-%m-%dT%H:%M:%SZ)
    TRACES=$(api_get "$API_URL/api/v1/traces?org_id=$ORG_ID&from=$FROM_ISO&to=$TO_ISO" || echo '{}')
    MID_COUNT=$(echo "$TRACES" | grep -c "\"span_id\":\"$SPAN_MID\"" || true)
    OLD_COUNT=$(echo "$TRACES" | grep -c "\"span_id\":\"$SPAN_OLD\"" || true)
    NEW_COUNT=$(echo "$TRACES" | grep -c "\"span_id\":\"$SPAN_NEW\"" || true)
    if [ "$MID_COUNT" = "1" ] && [ "$OLD_COUNT" = "0" ] && [ "$NEW_COUNT" = "0" ]; then
        pass "$TEST_NAME (returned mid only)"
    else
        fail "$TEST_NAME" "window [$FROM_ISO..$TO_ISO] returned mid=$MID_COUNT old=$OLD_COUNT new=$NEW_COUNT (expected 1 0 0)"
    fi
fi

# ─── 6. Offset durability sanity: durable file exists on persistent volume ───
# We don't restart the processor here (would interfere with concurrent test
# runs and the in-process buffer would replay) — just confirm the offset
# file exists at the configured path after the processor has been running
# and writing data through the new code path.
#
# The compose file sets PROCESSOR_OFFSET_FILE=/var/lib/scopecall/processor.offset
# backed by the processor-data named volume.
TEST_NAME="offset durability: file persists on the processor-data volume"
EXPECTED_PATH="${PROCESSOR_OFFSET_FILE:-/var/lib/scopecall/processor.offset}"
if docker exec scopecall-processor sh -c "ls -la $EXPECTED_PATH" 2>/dev/null \
        | grep -q processor.offset; then
    OFFSET_VAL=$(docker exec scopecall-processor sh -c "cat $EXPECTED_PATH" 2>/dev/null || echo "?")
    pass "$TEST_NAME (path=$EXPECTED_PATH, offset=$OFFSET_VAL)"
else
    fail "$TEST_NAME" "no offset file at $EXPECTED_PATH — processor isn't persisting (volume not mounted? PROCESSOR_OFFSET_FILE env not set?)"
fi

# ─── 7. Workflow spans persist (Round-3 P0) ──────────────────────────────────
# Send a synthetic workflow event + an LLM event under the same trace_id.
# Assert that the trace tree returns BOTH rows, and that the LLM event's
# parent_span_id resolves to a real span in storage.
TEST_NAME="workflow span persisted: trace tree returns workflow + child LLM call"
WF_SUFFIX=$(head -c 8 /dev/urandom | xxd -p)
TRACE_ID="trace_wf_${WF_SUFFIX}"
WORKFLOW_SPAN="span_wf_${WF_SUFFIX}"
LLM_SPAN="span_wf_llm_${WF_SUFFIX}"
BODY=$(cat <<EOF
{
  "events": [
    {
      "span_id": "$WORKFLOW_SPAN",
      "trace_id": "$TRACE_ID",
      "parent_span_id": null,
      "timestamp": $NOW_MS,
      "latency_ms": 1234,
      "model": "",
      "provider": "",
      "input_tokens": 0,
      "output_tokens": 0,
      "cost_usd": 0,
      "status": "success",
      "input_text": "",
      "output_text": "",
      "feature_name": "billing-agent",
      "environment": "test",
      "sdk_version": "e2e-0.0.0",
      "kind": "workflow"
    },
    {
      "span_id": "$LLM_SPAN",
      "trace_id": "$TRACE_ID",
      "parent_span_id": "$WORKFLOW_SPAN",
      "timestamp": $NOW_MS,
      "latency_ms": 200,
      "model": "gpt-4o",
      "provider": "openai",
      "input_tokens": 100,
      "output_tokens": 50,
      "cost_usd": 0.0,
      "status": "success",
      "input_text": "child call",
      "output_text": "ok",
      "feature_name": "billing-agent",
      "environment": "test",
      "sdk_version": "e2e-0.0.0",
      "kind": "llm"
    }
  ],
  "sent_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
INGEST_CODE=$(curl -sS -o /tmp/e2e-wf.body -w "%{http_code}" \
    -X POST "$INGEST_URL" \
    -H "Authorization: Bearer $SDK_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY")
sleep 3

if [ "$INGEST_CODE" != "200" ] && [ "$INGEST_CODE" != "202" ] && [ "$INGEST_CODE" != "204" ]; then
    fail "$TEST_NAME" "ingest rejected ($INGEST_CODE): $(cat /tmp/e2e-wf.body)"
else
    # Both rows in CH? Workflow row carries kind='workflow'; LLM row's
    # parent_span_id points at the workflow row's span_id.
    WORKFLOW_ROWS=$(ch_query "SELECT count() FROM llm_calls WHERE trace_id = '$TRACE_ID' AND kind = 'workflow'")
    LLM_ROWS=$(ch_query "SELECT count() FROM llm_calls WHERE trace_id = '$TRACE_ID' AND kind = 'llm'")
    # The JOIN that the trace-tree relies on: child.parent_span_id = parent.span_id
    EDGES=$(ch_query "SELECT count() FROM llm_calls c JOIN llm_calls p ON c.parent_span_id = p.span_id WHERE c.trace_id = '$TRACE_ID' AND p.trace_id = '$TRACE_ID'")
    if [ "$WORKFLOW_ROWS" = "1" ] && [ "$LLM_ROWS" = "1" ] && [ "$EDGES" = "1" ]; then
        pass "$TEST_NAME (1 workflow + 1 llm + 1 join edge)"
    else
        fail "$TEST_NAME" "expected 1 workflow + 1 llm row + 1 edge, got workflow=$WORKFLOW_ROWS llm=$LLM_ROWS edges=$EDGES"
    fi
fi

# ─── 8. Flow Map reflects the persisted workflow span (Round-4) ──────────────
# Hits /api/v1/graph and asserts the workflow→LLM edge from test #7 is
# present in the response. This is the proof that fixing the trace-tree
# JOIN (Round 3) also fixes the flow-map JOIN (same query layer). Without
# this, the workflow story holds on the trace detail page but the Flow
# Map can still render flat.
TEST_NAME="Flow Map: /api/v1/graph returns the workflow → LLM edge"
# The workflow + LLM spans from test #7 share trace_id, both timestamped at $NOW_MS,
# both with feature_name='billing-agent'. The expected node IDs:
#   workflow:  "billing-agent|"          (model="")
#   llm:       "billing-agent|gpt-4o"
WIDE_FROM=$(python3 -c "import datetime; print(datetime.datetime.utcfromtimestamp(($NOW_MS - 3600000) / 1000).strftime('%Y-%m-%dT%H:%M:%SZ'))" 2>/dev/null || \
            date -u -r $(((NOW_MS - 3600000)/1000)) +%Y-%m-%dT%H:%M:%SZ)
WIDE_TO=$(python3 -c "import datetime; print(datetime.datetime.utcfromtimestamp(($NOW_MS + 600000) / 1000).strftime('%Y-%m-%dT%H:%M:%SZ'))" 2>/dev/null || \
          date -u -r $(((NOW_MS + 600000)/1000)) +%Y-%m-%dT%H:%M:%SZ)
GRAPH=$(api_get "$API_URL/api/v1/graph?org_id=$ORG_ID&from=$WIDE_FROM&to=$WIDE_TO" || echo '{}')
# Looking for a workflow node ("billing-agent|") AND an edge from it to
# the LLM node ("billing-agent|gpt-4o"). Use grep -F to avoid regex
# escaping on the | character.
HAS_WORKFLOW_NODE=$(echo "$GRAPH" | grep -cF '"id":"billing-agent|"' || true)
HAS_EDGE=$(echo "$GRAPH" \
    | grep -cF '"from":"billing-agent|","to":"billing-agent|gpt-4o"' \
    || true)
if [ "$HAS_WORKFLOW_NODE" -ge 1 ] && [ "$HAS_EDGE" -ge 1 ]; then
    pass "$TEST_NAME (node present + edge present)"
else
    fail "$TEST_NAME" "expected workflow node + edge; got workflow_node=$HAS_WORKFLOW_NODE edge=$HAS_EDGE. Response: $(echo "$GRAPH" | head -c 400)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────────"
echo " RESULTS: $PASS passed, $FAIL failed"
echo "──────────────────────────────────────────────"
if [ "$FAIL" -gt 0 ]; then
    for r in "${RESULTS[@]}"; do
        case "$r" in FAIL*) echo "$r" ;; esac
    done
    exit 1
fi
exit 0
