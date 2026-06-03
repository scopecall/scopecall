#!/usr/bin/env python3
"""
Seed realistic demo data into a running ScopeCall stack so the dashboard
shows charts instead of empty states. Sends events through the actual
ingest service (NOT direct ClickHouse INSERT) so:

- The processor's server-side pricing runs (cost_usd is recomputed).
- The llm_calls_to_metrics_mv populates llm_metrics_hourly (with the
  Round-4 `kind = 'llm'` filter, so workflow rows correctly don't
  inflate the rollup).
- Field validation runs (catches any schema drift between SDK and
  ingest before it ships).

Data shape (round 4):
- 3 features (billing-agent, code-reviewer, customer-support) with 2-3
  prompt versions each.
- 3 models (gpt-4o, claude-3-5-sonnet, gpt-4o-mini).
- 60 trace blocks via sdk.trace() each emitting 1 workflow span +
  2-5 LLM child calls. Workflow span gets a real span_id that all the
  LLM children reference as parent_span_id — gives the Flow Map real
  parent → child edges, not the synthesised id=span_id hack.
- 200 standalone LLM calls (no workflow wrap) so the Traces list has
  both shapes.
- Spread across the last 24 hours; some 6h-ago to populate hourly
  buckets across the curve.
- 4% error rate, 1.5% timeouts, 0.5% rate_limited — realistic for a
  production app, enough to make error charts non-trivial.

Usage:
    bash scripts/bootstrap-for-review.sh   # one-time
    python3 scripts/seed-demo-data.py [--clean] [--count N]

--clean: TRUNCATE llm_calls + llm_metrics_hourly before seeding.
--count: scale the dataset (default 60 traces + 200 standalone calls).
"""

import argparse
import datetime as dt
import json
import random
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

# ─── Config ──────────────────────────────────────────────────────────────────
INGEST_URL   = "http://localhost:8080/v1/ingest"
SDK_API_KEY  = "sc_live_dev_000000000000000000"   # matches bootstrap-for-review

FEATURES = ["billing-agent", "code-reviewer", "customer-support"]
PROMPT_VERSIONS = {
    "billing-agent":     ["v1", "v2", "v3-beta"],
    "code-reviewer":     ["v1", "v2"],
    "customer-support":  ["v4", "v5", "v6"],
}
MODELS = [
    # (model, provider, weight) — weights bias the sample
    ("gpt-4o",            "openai",     3),
    ("gpt-4o-mini",       "openai",     2),
    ("claude-3-5-sonnet", "anthropic",  1),
]
USERS = [f"user_{i:03d}" for i in range(20)]
SESSIONS = [f"session_{i:03d}" for i in range(40)]
ENV = "production"

STATUS_WEIGHTS = [
    ("success",       940),
    ("error",          40),
    ("timeout",        15),
    ("rate_limited",    5),
]

def weighted(pairs):
    total = sum(w for _, w in pairs)
    r = random.uniform(0, total)
    acc = 0
    for value, w in pairs:
        acc += w
        if r <= acc:
            return value
    return pairs[-1][0]

def pick_model():
    weights = [(m, p, w) for (m, p, w) in MODELS]
    total = sum(w for *_, w in weights)
    r = random.uniform(0, total)
    acc = 0
    for m, p, w in weights:
        acc += w
        if r <= acc:
            return m, p
    return weights[-1][0], weights[-1][1]

# ─── Event construction ──────────────────────────────────────────────────────
def make_llm_event(*, feature, prompt_ver, parent_span_id, trace_id, when_ms):
    """One LLM-call event. Server will reprice from tokens."""
    model, provider = pick_model()
    in_tok = random.randint(100, 2000)
    out_tok = random.randint(50, 800)
    latency = random.randint(180, 2400)
    status = weighted(STATUS_WEIGHTS)
    return {
        "span_id":        f"span_{uuid.uuid4().hex[:16]}",
        "trace_id":       trace_id,
        "parent_span_id": parent_span_id,
        "timestamp":      when_ms,
        "latency_ms":     latency,
        "ttft_ms":        random.randint(80, 400) if random.random() < 0.4 else None,
        "model":          model,
        "provider":       provider,
        "input_tokens":   in_tok,
        "output_tokens":  out_tok,
        # Cost is recomputed server-side — set 0 here so any divergence is
        # obvious (the dashboard would show 0 if the processor pricer fails).
        "cost_usd":       0.0,
        "status":         status,
        "error_message":  None if status == "success" else f"{status} from {provider}",
        "input_text":     f"Demo input for {feature} (prompt {prompt_ver})",
        "output_text":    f"Demo output. tokens={out_tok}",
        "feature_name":   feature,
        "user_id":        random.choice(USERS),
        "session_id":     random.choice(SESSIONS),
        "environment":    ENV,
        "sdk_version":    "demo-seed-0.1.1",
        "extra":          None,
        "finish_reason":  "stop" if status == "success" else "length",
        "cache_read_tokens": random.randint(50, 800) if random.random() < 0.15 else None,
        "original_model": None,
        "budget_state":   None,
        "failure_mode":   None,
        "tool_calls":     None,
        "prompt_version": prompt_ver,
        "kind":           "llm",
    }

def make_workflow_event(*, feature, prompt_ver, span_id, trace_id, when_ms, latency_ms, status):
    """One workflow-span event matching what sdk.trace() emits."""
    return {
        "span_id":        span_id,
        "trace_id":       trace_id,
        "parent_span_id": None,
        "timestamp":      when_ms,
        "latency_ms":     latency_ms,
        "ttft_ms":        None,
        "model":          "",        # processor zeros these anyway
        "provider":       "",
        "input_tokens":   0,
        "output_tokens":  0,
        "cost_usd":       0.0,
        "status":         status,
        "error_message":  None if status == "success" else "trace block threw",
        "input_text":     "",
        "output_text":    "",
        "feature_name":   feature,
        "user_id":        random.choice(USERS),
        "session_id":     random.choice(SESSIONS),
        "environment":    ENV,
        "sdk_version":    "demo-seed-0.1.1",
        "extra":          None,
        "finish_reason":  None,
        "cache_read_tokens": None,
        "original_model": None,
        "budget_state":   None,
        "failure_mode":   None,
        "tool_calls":     None,
        "prompt_version": prompt_ver,
        "kind":           "workflow",
    }

# ─── Cleanup ─────────────────────────────────────────────────────────────────
def clean_clickhouse():
    """Wipe llm_calls + llm_metrics_hourly. Run via docker exec since CH
    isn't exposed on the host port in the default compose."""
    print("→ Cleaning ClickHouse…")
    for stmt in [
        "TRUNCATE TABLE IF EXISTS llm_calls",
        "TRUNCATE TABLE IF EXISTS llm_metrics_hourly",
    ]:
        r = subprocess.run(
            ["docker", "exec", "scopecall-clickhouse",
             "clickhouse-client", "--query", stmt],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"  WARNING: {stmt!r} failed: {r.stderr.strip()}",
                  file=sys.stderr)

# ─── Posting ─────────────────────────────────────────────────────────────────
def post_batch(events):
    body = json.dumps({
        "events":  events,
        "sent_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }).encode("utf-8")
    req = urllib.request.Request(
        INGEST_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {SDK_API_KEY}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", action="store_true",
                    help="TRUNCATE llm_calls + llm_metrics_hourly first")
    ap.add_argument("--traces", type=int, default=60,
                    help="number of workflow-wrapped traces to generate")
    ap.add_argument("--standalone", type=int, default=200,
                    help="number of standalone LLM calls (no workflow wrap)")
    args = ap.parse_args()

    if args.clean:
        clean_clickhouse()
        # Brief pause so the truncate fully settles before we start writing.
        time.sleep(1)

    random.seed(42)
    now_ms = int(time.time() * 1000)
    one_day_ms = 24 * 3600 * 1000

    all_events = []

    # ── Workflow-wrapped traces ──────────────────────────────────────────────
    for i in range(args.traces):
        feature = random.choice(FEATURES)
        prompt_ver = random.choice(PROMPT_VERSIONS[feature])
        # Timestamp spread across 24h, bias slightly toward recent.
        offset = int(random.triangular(0, one_day_ms, one_day_ms * 0.3))
        when_ms = now_ms - offset
        n_children = random.randint(2, 5)
        # Workflow status mostly succeeds. 5% block-level failure.
        wf_status = "success" if random.random() < 0.95 else "error"

        workflow_span_id = f"span_wf_{uuid.uuid4().hex[:16]}"
        trace_id = f"trace_{uuid.uuid4().hex[:16]}"

        # Generate children first to compute workflow latency
        children = []
        cumulative = 0
        for _ in range(n_children):
            child_ts = when_ms + cumulative
            ev = make_llm_event(
                feature=feature,
                prompt_ver=prompt_ver,
                parent_span_id=workflow_span_id,
                trace_id=trace_id,
                when_ms=child_ts,
            )
            children.append(ev)
            cumulative += ev["latency_ms"]

        # Workflow latency = sum of children + 50-200ms overhead
        workflow_latency = cumulative + random.randint(50, 200)
        wf = make_workflow_event(
            feature=feature,
            prompt_ver=prompt_ver,
            span_id=workflow_span_id,
            trace_id=trace_id,
            when_ms=when_ms,
            latency_ms=workflow_latency,
            status=wf_status,
        )
        all_events.append(wf)
        all_events.extend(children)

    # ── Standalone LLM calls (no workflow wrap) ──────────────────────────────
    for _ in range(args.standalone):
        feature = random.choice(FEATURES)
        prompt_ver = random.choice(PROMPT_VERSIONS[feature])
        offset = random.randint(0, one_day_ms)
        when_ms = now_ms - offset
        span_id = f"span_{uuid.uuid4().hex[:16]}"
        # Standalone calls get trace_id = span_id (single-span trace), matching
        # what the TS SDK does when no sdk.trace() block wraps them.
        ev = make_llm_event(
            feature=feature,
            prompt_ver=prompt_ver,
            parent_span_id=None,
            trace_id=span_id,
            when_ms=when_ms,
        )
        ev["span_id"] = span_id
        all_events.append(ev)

    # ── Batch + POST. Ingest cap is 1000 events per batch. ───────────────────
    BATCH = 500
    workflows = sum(1 for e in all_events if e["kind"] == "workflow")
    llms = sum(1 for e in all_events if e["kind"] == "llm")
    print(f"→ Generated {len(all_events)} events "
          f"({workflows} workflow + {llms} llm). Posting in batches of {BATCH}…")

    sent = 0
    failed = 0
    for i in range(0, len(all_events), BATCH):
        chunk = all_events[i : i + BATCH]
        status, body = post_batch(chunk)
        if status in (200, 202, 204):
            sent += len(chunk)
            print(f"  ✓ batch {i//BATCH + 1}: {len(chunk)} events, HTTP {status}")
        else:
            failed += len(chunk)
            print(f"  ✗ batch {i//BATCH + 1}: HTTP {status} — {body[:200]!r}",
                  file=sys.stderr)

    print(f"\n→ Done: {sent} sent, {failed} failed.")
    if failed:
        sys.exit(1)

    # Wait for the processor to drain.
    print("→ Waiting 3s for processor to flush to ClickHouse…")
    time.sleep(3)

    # Quick verification: row counts + kind distribution.
    r = subprocess.run(
        ["docker", "exec", "scopecall-clickhouse", "clickhouse-client",
         "--query",
         "SELECT count() AS rows, countIf(kind='llm') AS llm_rows, "
         "countIf(kind='workflow') AS workflow_rows, "
         "uniqExact(trace_id) AS traces, sum(cost_usd) AS total_cost "
         "FROM llm_calls"],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        cols = r.stdout.strip().split("\t")
        print(f"\nClickHouse now contains:")
        print(f"  total rows:     {cols[0]}")
        print(f"  LLM rows:       {cols[1]}")
        print(f"  workflow rows:  {cols[2]}")
        print(f"  unique traces:  {cols[3]}")
        print(f"  total cost:     ${cols[4]}")
    else:
        print(f"  (verification query failed: {r.stderr})")

if __name__ == "__main__":
    main()
