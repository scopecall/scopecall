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

Data shape:
- 3 features (billing-agent, code-reviewer, customer-support) with 2-3
  prompt versions each.
- 3 models (gpt-4o, claude-3-5-sonnet, gpt-4o-mini).
- 150 trace blocks via sdk.trace(), each a workflow span + 2-5 LLM
  children. A weighted subset nests deeper — workflow → agent → llm
  (~35%) and the full workflow → agent → step → llm (~25%) — emitting
  real kind='agent'/'step' container spans linked by parent_span_id.
  This gives the Traces-list breadcrumb (workflow › agent › step ›
  model) real ancestry to resolve, and the Flow Map real edges.
- 500 standalone LLM calls (no workflow wrap) so the Traces list has
  both shapes.
- Spread across the trailing 7 days (--days), traces biased toward
  recent so daily + hourly buckets are populated across the curve.
- 4% error rate, 1.5% timeouts, 0.5% rate_limited — realistic for a
  production app, enough to make error charts non-trivial.
- ~13% of LLM calls model an application-level retry: a failed attempt 1
  (output_tokens=0 → input-only "wasted" cost) followed, after a backoff,
  by a succeeded attempt 2 carrying attempt_number=2 + a retry_reason. Both
  attempts share span_id (distinct timestamps), which is what populates the
  trace drawer's ATTEMPTS section and fires the Waste Inbox retry_burner.

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

# B2B customers (tenants) — distinct from USERS (end-users): one customer has
# many users. Weighted so a few accounts dominate spend, which is what makes the
# Customer Profitability page interesting (acme-corp ~3× the smallest). A slice
# of traffic is left unattributed (customer_id=None) to populate the
# "Unattributed" tile on the Customers page and the breakdown's null bucket.
CUSTOMERS = [
    ("acme-corp",         30),
    ("globex",            22),
    ("initech",           16),
    ("umbrella",          12),
    ("hooli",             12),
    ("stark-industries",   8),
]
UNATTRIBUTED_RATE = 0.18  # fraction of traffic with no customer_id

# Container-span names for the workflow → agent → step hierarchy. The seed
# nests a subset of traces so the Traces-list breadcrumb (workflow › agent ›
# step › model) has real ancestry to resolve — these are emitted as kind=
# 'agent' / 'step' spans with their NAME in feature_name, linked by
# parent_span_id, exactly as sdk.agent()/sdk.step() persist them.
AGENTS = ["planner", "researcher", "executor", "critic"]
STEPS = ["retrieve-context", "draft-response", "tool-call", "validate", "summarize"]

# How deeply each workflow-wrapped trace nests, weighted for a realistic mix
# on the Traces list: some flat workflow→llm, some workflow→agent→llm, some
# the full workflow→agent→step→llm path.
TRACE_SHAPES = [
    ("wf", 40),             # workflow → llm
    ("wf_agent", 35),       # workflow → agent → llm
    ("wf_agent_step", 25),  # workflow → agent → step → llm
]

STATUS_WEIGHTS = [
    ("success",       940),
    ("error",          40),
    ("timeout",        15),
    ("rate_limited",    5),
]

# v0.3 retry attribution. ~13% of LLM calls model an APPLICATION-level retry:
# attempt 1 fails, the caller waits a backoff, then re-issues the SAME logical
# call (same span_id, later timestamp) which succeeds as attempt 2. This is what
# lights up the drawer's ATTEMPTS section and the Waste Inbox retry_burner rule.
# Both attempts share span_id; only the timestamp differs, so ReplacingMergeTree
# keeps both rows (it dedups on (org_id, timestamp, span_id)).
RETRY_RATE = 0.13
# Why the retry happened. attempt_number=1 always has retry_reason=NULL; the
# reason is stamped on the SUCCESSFUL attempt 2 (it names why the prior failed).
RETRY_REASONS = [
    ("rate_limit",         40),
    ("timeout",            22),
    ("server_error",       20),
    ("transient_network",  18),
]
# Map a retry reason → the status the FAILED first attempt carries.
RETRY_FAIL_STATUS = {
    "rate_limit":        "rate_limited",
    "timeout":           "timeout",
    "server_error":      "error",
    "transient_network": "error",
}

def weighted(pairs):
    total = sum(w for _, w in pairs)
    r = random.uniform(0, total)
    acc = 0
    for value, w in pairs:
        acc += w
        if r <= acc:
            return value
    return pairs[-1][0]

def pick_customer():
    """A weighted B2B customer slug, or None for unattributed traffic. Pick
    ONCE per trace (the whole span tree shares a tenant) and per standalone
    call — mirrors how customer_id is inherited from the root span by the SDK."""
    if random.random() < UNATTRIBUTED_RATE:
        return None
    return weighted(CUSTOMERS)

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
def make_llm_event(*, feature, prompt_ver, parent_span_id, trace_id, when_ms, customer_id=None):
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
        "customer_id":    customer_id,
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
        # Default: a single-attempt call. maybe_retry() rewrites these on the
        # ~13% of calls that model an application-level retry.
        "attempt_number": 1,
        "retry_reason":   None,
    }

def make_container_event(*, kind, name, prompt_ver, span_id, parent_span_id,
                         trace_id, when_ms, latency_ms, status, customer_id=None):
    """One container-span event (kind ∈ workflow/agent/step), matching what
    sdk.trace()/sdk.agent()/sdk.step() emit. Carries no model/tokens/cost of
    its own (the processor zeros those and the analytics exclude kind!='llm');
    its NAME lives in feature_name, which the Traces-list breadcrumb resolves
    by walking parent_span_id up from each LLM child."""
    return {
        "span_id":        span_id,
        "trace_id":       trace_id,
        "parent_span_id": parent_span_id,
        "timestamp":      when_ms,
        "latency_ms":     latency_ms,
        "ttft_ms":        None,
        "model":          "",        # processor zeros these anyway
        "provider":       "",
        "input_tokens":   0,
        "output_tokens":  0,
        "cost_usd":       0.0,
        "status":         status,
        "error_message":  None if status == "success" else f"{kind} span threw",
        "input_text":     "",
        "output_text":    "",
        "feature_name":   name,
        "user_id":        random.choice(USERS),
        "customer_id":    customer_id,
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
        "kind":           kind,
    }

def maybe_retry(ev, start_ts):
    """Maybe turn one LLM event into a retry pair (failed attempt 1 → succeeded
    attempt 2). Returns (events, wall_ms): the list of events to emit (one or
    two) and the wall-clock time the whole thing consumed, so the caller can
    advance its cumulative latency cursor correctly.

    Both attempts share span_id (already set on `ev`) but get distinct
    timestamps, so ClickHouse keeps both rows. The failed attempt has
    output_tokens=0 → the processor reprices it to an input-only cost (small but
    non-zero), which is the "wasted spend" the drawer banner surfaces. The
    succeeded attempt keeps the original tokens and carries attempt_number=2 +
    retry_reason, which is what the Waste Inbox retry_burner rule keys off."""
    if random.random() >= RETRY_RATE:
        return [ev], ev["latency_ms"]

    reason = weighted(RETRY_REASONS)
    fail_status = RETRY_FAIL_STATUS[reason]

    # How long the failed attempt ran before giving up. Timeouts burn the most
    # wall-clock; rate limits fail fast (the provider rejects almost instantly).
    if reason == "timeout":
        l1 = random.randint(1800, 4000)
    elif reason == "rate_limit":
        l1 = random.randint(40, 250)
    else:
        l1 = random.randint(120, 1200)
    backoff = random.randint(200, 1500)

    failed = dict(ev)
    failed["timestamp"]     = start_ts
    failed["latency_ms"]    = l1
    failed["ttft_ms"]       = None
    failed["output_tokens"] = 0       # input-only cost after server reprice
    failed["output_text"]   = ""
    failed["status"]        = fail_status
    failed["error_message"] = f"{fail_status} from {ev['provider']} (attempt 1)"
    failed["finish_reason"] = "error"
    failed["attempt_number"] = 1
    failed["retry_reason"]   = None   # attempt 1 never carries a reason

    # The original event becomes the SUCCESSFUL retry: same span_id, later
    # timestamp, full tokens/cost, attempt_number=2 + the reason it retried.
    ev["timestamp"]      = start_ts + l1 + backoff
    ev["status"]         = "success"
    ev["error_message"]  = None
    ev["finish_reason"]  = "stop"
    ev["attempt_number"] = 2
    ev["retry_reason"]   = reason

    return [failed, ev], l1 + backoff + ev["latency_ms"]

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
    ap.add_argument("--traces", type=int, default=150,
                    help="number of workflow-wrapped traces to generate")
    ap.add_argument("--standalone", type=int, default=500,
                    help="number of standalone LLM calls (no workflow wrap)")
    ap.add_argument("--days", type=int, default=7,
                    help="spread events across the trailing N days")
    args = ap.parse_args()

    if args.clean:
        clean_clickhouse()
        # Brief pause so the truncate fully settles before we start writing.
        time.sleep(1)

    random.seed(42)
    now_ms = int(time.time() * 1000)
    window_ms = args.days * 24 * 3600 * 1000

    all_events = []

    # ── Workflow-wrapped traces ──────────────────────────────────────────────
    for i in range(args.traces):
        feature = random.choice(FEATURES)
        prompt_ver = random.choice(PROMPT_VERSIONS[feature])
        # One customer per trace — the whole span tree shares a tenant.
        customer = pick_customer()
        # Timestamp spread across the window, bias toward recent (mode near now).
        offset = int(random.triangular(0, window_ms, window_ms * 0.2))
        when_ms = now_ms - offset
        n_children = random.randint(2, 5)
        # Workflow status mostly succeeds. 5% block-level failure.
        wf_status = "success" if random.random() < 0.95 else "error"

        trace_id = f"trace_{uuid.uuid4().hex[:16]}"
        workflow_span_id = f"span_wf_{uuid.uuid4().hex[:16]}"

        # Decide the nesting depth, then mint the container span_ids present at
        # this depth. The LLM children hang off the DEEPEST container so the
        # breadcrumb resolves workflow → agent → step on the way up.
        shape = weighted(TRACE_SHAPES)
        agent_span_id = (
            f"span_ag_{uuid.uuid4().hex[:16]}"
            if shape in ("wf_agent", "wf_agent_step")
            else None
        )
        step_span_id = (
            f"span_st_{uuid.uuid4().hex[:16]}" if shape == "wf_agent_step" else None
        )
        child_parent = step_span_id or agent_span_id or workflow_span_id

        # Generate children first to compute container latencies.
        children = []
        cumulative = 0
        for _ in range(n_children):
            child_ts = when_ms + cumulative
            ev = make_llm_event(
                feature=feature,
                prompt_ver=prompt_ver,
                parent_span_id=child_parent,
                trace_id=trace_id,
                when_ms=child_ts,
                customer_id=customer,
            )
            # ~13% of calls expand into a retry pair (failed attempt 1 →
            # succeeded attempt 2). `wall` spans both attempts + backoff so the
            # container-latency rollup below still bounds the children correctly.
            attempts, wall = maybe_retry(ev, child_ts)
            children.extend(attempts)
            cumulative += wall

        # Each present container wraps the one below it (+ a little overhead),
        # so workflow latency ≥ agent ≥ step ≥ sum(children).
        deepest_latency = cumulative
        if step_span_id:
            step_latency = deepest_latency + random.randint(20, 80)
            deepest_latency = step_latency
            all_events.append(make_container_event(
                kind="step", name=random.choice(STEPS), prompt_ver=prompt_ver,
                span_id=step_span_id, parent_span_id=agent_span_id,
                trace_id=trace_id, when_ms=when_ms,
                latency_ms=step_latency, status=wf_status,
                customer_id=customer,
            ))
        if agent_span_id:
            agent_latency = deepest_latency + random.randint(30, 120)
            deepest_latency = agent_latency
            all_events.append(make_container_event(
                kind="agent", name=random.choice(AGENTS), prompt_ver=prompt_ver,
                span_id=agent_span_id, parent_span_id=workflow_span_id,
                trace_id=trace_id, when_ms=when_ms,
                latency_ms=agent_latency, status=wf_status,
                customer_id=customer,
            ))
        workflow_latency = deepest_latency + random.randint(50, 200)
        all_events.append(make_container_event(
            kind="workflow", name=feature, prompt_ver=prompt_ver,
            span_id=workflow_span_id, parent_span_id=None,
            trace_id=trace_id, when_ms=when_ms,
            latency_ms=workflow_latency, status=wf_status,
            customer_id=customer,
        ))
        all_events.extend(children)

    # ── Standalone LLM calls (no workflow wrap) ──────────────────────────────
    for _ in range(args.standalone):
        feature = random.choice(FEATURES)
        prompt_ver = random.choice(PROMPT_VERSIONS[feature])
        customer = pick_customer()
        offset = random.randint(0, window_ms)
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
            customer_id=customer,
        )
        ev["span_id"] = span_id
        # Standalone calls retry too. Both attempts share span_id AND trace_id
        # (trace_id == span_id for an un-wrapped call), so the drawer still
        # groups them into one ATTEMPTS list.
        attempts, _ = maybe_retry(ev, when_ms)
        all_events.extend(attempts)

    # ── Batch + POST. Ingest cap is 1000 events per batch. ───────────────────
    BATCH = 500
    workflows = sum(1 for e in all_events if e["kind"] == "workflow")
    agents = sum(1 for e in all_events if e["kind"] == "agent")
    steps = sum(1 for e in all_events if e["kind"] == "step")
    llms = sum(1 for e in all_events if e["kind"] == "llm")
    print(f"→ Generated {len(all_events)} events "
          f"({workflows} workflow + {agents} agent + {steps} step + {llms} llm). "
          f"Posting in batches of {BATCH}…")

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
         "countIf(kind='agent') AS agent_rows, "
         "countIf(kind='step') AS step_rows, "
         "uniqExact(trace_id) AS traces, sum(cost_usd) AS total_cost, "
         "countIf(attempt_number > 1) AS retry_rows, "
         "sumIf(cost_usd, attempt_number > 1) AS retry_cost "
         "FROM llm_calls"],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        cols = r.stdout.strip().split("\t")
        print(f"\nClickHouse now contains:")
        print(f"  total rows:     {cols[0]}")
        print(f"  LLM rows:       {cols[1]}")
        print(f"  workflow rows:  {cols[2]}")
        print(f"  agent rows:     {cols[3]}")
        print(f"  step rows:      {cols[4]}")
        print(f"  unique traces:  {cols[5]}")
        print(f"  total cost:     ${cols[6]}")
        print(f"  retry attempts: {cols[7]} (attempt_number > 1)")
        print(f"  retry cost:     ${cols[8]} (successful-retry spend)")
    else:
        print(f"  (verification query failed: {r.stderr})")

if __name__ == "__main__":
    main()
