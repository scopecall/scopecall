<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/hero-dark.svg">
    <img alt="ScopeCall — See every call. Own your AI bill." src="assets/brand/hero-light.svg" width="800">
  </picture>
</p>

<h1 align="center">ScopeCall</h1>

<p align="center">
  <a href="https://github.com/scopecall/scopecall/releases/tag/v0.1.1"><img src="https://img.shields.io/badge/version-v0.1.1-6366f1" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <a href="https://www.npmjs.com/package/@scopecall/scopecall-js"><img src="https://img.shields.io/npm/v/@scopecall/scopecall-js?label=npm&color=cb3837" alt="npm"></a>
  <a href="https://pypi.org/project/scopecall-py/"><img src="https://img.shields.io/pypi/v/scopecall-py?label=pypi&color=3776ab" alt="PyPI"></a>
  <a href="https://scopecall.com/docs"><img src="https://img.shields.io/badge/docs-scopecall.com%2Fdocs-informational" alt="Docs"></a>
</p>

---

[ScopeCall](https://scopecall.com) is open-source (Apache 2.0), self-hostable AI cost and workflow observability. Find the prompt, customer, model, and workflow path behind every LLM cost spike — without routing traffic through a proxy.

ScopeCall captures LLM traces via SDK instrumentation (no added latency, no proxy) — TypeScript (OpenAI, Anthropic, Vercel AI SDK) and Python (OpenAI, Anthropic; sync, async, streaming) — ships the events to a self-hosted ClickHouse + Postgres stack, and displays them in a real-time dashboard with cost / latency / prompt-version breakdowns. Budget enforcement and an agent execution debugger are on the roadmap.

Licensed under [Apache 2.0](LICENSE). Free for any use — self-hosted, commercial, modified, redistributed. We monetize via the managed-cloud product (in development) and enterprise features, not via licensing teeth.

---

## What ships in v0.3.0

The cost-attribution release — answers "which workflow, which agent,
which customer, which retry was that dollar?" without proxying provider
traffic.

**Capture path (SDK + ingest + processor):**

- `sdk.workflow(name)` / `sdk.agent(name)` / `sdk.step(name)` —
  three nested context managers (Python + TypeScript) that emit
  distinct container span kinds. Nesting is voluntary, not enforced;
  the dashboard rolls up cost from LLM calls to whichever ancestor
  you wrap.
- `customer_id` kwarg on `trace()` / `workflow()` / `agent()` /
  `step()` / `record_llm_call()` — B2B tenant attribution distinct
  from `user_id`. Inherits from parent spans.
- `attempt_number` + `retry_reason` (closed enum) on
  `record_llm_call()` for retry attribution.
- `ScopeCallConfig.test = true` (or `SCOPECALL_TEST=1`) tags every
  event with `is_test=true` so eval / CI / replay traffic stays out
  of production cost reports.
- `cost_source` (`server_computed` | `sdk_fallback` | `unknown_model`
  | `container`) + `pricing_version` (YYYY-MM-DD) — server-derived
  trust metadata on every row. Surfaces in the Cost Confidence card
  so the dashboard tells you what fraction of its dollar number is
  verified vs. fiction.

**Dashboard (built on the capture path):**

- **Workflow Treemap** on Overview — tile area is cost, color is
  delta vs the prior window. One click to drill into a workflow.
- **Workflow detail page** — agent / step / customer / model
  breakdowns plus retry-cost and test-traffic callouts. Two-hop
  parent_span_id join attributes each LLM call to its enclosing
  step → agent.
- **Customers page** — per-customer rollup ranked by cost, with an
  attribution-coverage banner when `customer_id` isn't wired through
  and a retry-offender banner for the worst customer.
- **Waste Inbox** on Overview — deterministic-rule findings ranked
  by dollar impact (retry burners, model misuse, high-error
  workflows). Each item is a "save up to $X" line with a one-click
  drill to the offending traces.
- **Cost Confidence** card on Overview — stacked bar of `cost_source`
  shares + punch list of unknown models pointing at
  `schemas/pricing/pricing.json`.

**Plus everything from v0.1.1** — OpenAI / Anthropic / Vercel AI SDK
instrumentation (TS + Python), prompt-version analytics, server-
authoritative pricing, self-hosted Docker Compose stack, Auth.js, API
key management, alerts, durable processor offsets.

**Not yet in v0.3:** Gemini support (v0.3.1), OpenTelemetry GenAI
bridge (v0.4.x), native LangChain / LlamaIndex integrations (v0.5.0;
the manual `record_llm_call(...)` API works today as a bridge),
budget enforcement / model fallback (v0.6.0), agent execution
debugger (v0.7.0). See [roadmap](#roadmap) below.

---

## Quickstart

### 1. Start the stack

```bash
git clone https://github.com/scopecall/scopecall.git
cd scopecall

# Generate two required secrets in infra/.env (one-time setup).
cp infra/.env.example infra/.env
echo "AUTH_SECRET=$(openssl rand -hex 32)"      >> infra/.env
echo "INTERNAL_API_KEY=$(openssl rand -hex 32)" >> infra/.env

# Bring up the stack. The compose file lives at infra/docker-compose.yml
# and its relative volume paths resolve from that directory — always pass
# `-f infra/docker-compose.yml` rather than relying on auto-discovery.
docker compose -f infra/docker-compose.yml up -d

# First admin account: open the dashboard and complete the /setup flow.
```

Dashboard: http://localhost:3000  
Ingest (Rust): http://localhost:8080  
API (Go): http://localhost:8081

### 2. Generate an API key

Open the dashboard at <http://localhost:3000>, sign in with the admin
account you created during `/setup`, then go to **Settings → API Keys** (or
navigate to `/dashboard/settings/keys`) and click **Generate key**. Copy the
raw token immediately — ScopeCall only ever stores a hash, so the dashboard
can't show it to you again.

### 3. Install the SDK + instrument your app

Pick your stack. Both SDKs ship the same wire format and the same dashboard
features — workflow / agent / step cost-attribution hierarchy, `customer_id`
B2B tenant tagging, retry attribution, streaming + TTFT capture,
server-recomputed cost, prompt versioning, PII redaction.

#### TypeScript

```bash
npm install @scopecall/scopecall-js
```

```typescript
import { init } from "@scopecall/scopecall-js";
import OpenAI from "openai";

// init() returns the SDK instance. Call it once at app startup.
// `endpoint` is the ingest service URL — port 8080 in docker-compose,
// or your managed-cloud ingest URL.
const sdk = init({
  apiKey: process.env.SCOPECALL_API_KEY!,    // the key you generated in step 2
  endpoint: "http://localhost:8080/v1/ingest",
});

// Instrument the OpenAI client in place — all chat.completions.create
// calls through this instance get traced automatically.
const openai = new OpenAI();
sdk.instrument(openai);

// sdk.workflow() wraps a logical workflow. Cost from every LLM call
// inside it rolls up to this workflow on the dashboard's Workflow
// Treemap. `customerId` (v0.3) attributes the spend to a specific
// B2B tenant — surfaces on the /dashboard/customers page.
await sdk.workflow(
  "refund-bot",
  async () => {
    // Nested sdk.agent() / sdk.step() are optional — use them when you
    // want per-agent / per-step cost breakdowns in the workflow detail page.
    await sdk.agent("intent_router", async () => {
      await sdk.step("classify_intent", async () => {
        await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Hello" }],
        });
      });
    });
  },
  { customerId: "customer_acme" },
);
```

#### Python

```bash
pip install scopecall-py
# Or with provider extras (recommended):
pip install "scopecall-py[openai]"
pip install "scopecall-py[anthropic]"
```

```python
import os
import scopecall
from openai import OpenAI

sdk = scopecall.init(
    api_key=os.environ["SCOPECALL_API_KEY"],   # the key you generated in step 2
    endpoint="http://localhost:8080/v1/ingest",
)

# Auto-detects sync vs async — pass AsyncOpenAI() for async.
client = sdk.instrument(OpenAI())

# sdk.workflow() wraps a logical workflow. Cost from every LLM call
# inside it rolls up to this workflow on the dashboard's Workflow
# Treemap. `customer_id` (v0.3) attributes the spend to a specific
# B2B tenant — surfaces on the /dashboard/customers page.
with sdk.workflow("refund-bot", customer_id="customer_acme"):
    # Nested sdk.agent() / sdk.step() are optional — use them when
    # you want per-agent / per-step cost breakdowns in the workflow
    # detail page.
    with sdk.agent("intent_router"):
        with sdk.step("classify_intent"):
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "Hello"}],
            )

sdk.flush()   # ensure the event leaves the process before exit
```

Open the dashboard and your trace appears within seconds.

---

## Architecture

```
Your app (SDK)
    │  HTTP batch
    ▼
Rust ingest service (:8080)     ← validate + auth + publish to Kafka
    │  Redpanda (events.llm_calls)
    ▼
Rust processor                  ← consume → enrich (pricing) → write to ClickHouse
    │                             also: durable Kafka offset, DLQ on retry exhaustion
    ▼
ClickHouse                      ← trace events, hourly rollup MV, cost breakdown

Go API (:8081)                  ← auth, REST endpoints, alerts evaluator
    ├── reads ClickHouse        ← traces, cost, prompts, sessions, flow map
    └── reads / writes Postgres ← orgs, users, api_keys, saved views, alert rules

Next.js dashboard (:3000)       ← Auth.js sessions, proxies to Go API
```

Hot path is **SDK → Rust ingest → Redpanda → Rust processor → ClickHouse**.
The Go API is read-only against ClickHouse (plus auth / alerts state in
Postgres). The dashboard never talks to ClickHouse or Redpanda directly —
all reads go through the Go API.

---

## Roadmap

| Version | What ships |
|---------|-----------|
| **v0.1.0** | OpenAI tracing (TypeScript SDK), self-hosted stack, traces view, cost display |
| **v0.1.1** | Anthropic + Vercel AI SDK support; workflow spans; per-prompt-version analytics; API key management; durable processor offsets. **Python SDK** (`scopecall-py@0.2.0`) ships alongside with OpenAI + Anthropic sync/async/streaming instrumentation and a manual `record_llm_call(...)` API for LangChain / LlamaIndex / custom wrappers. |
| **v0.3.0** *(current)* | Cost attribution — `sdk.workflow()` / `sdk.agent()` / `sdk.step()` hierarchy, `customer_id` B2B tenant tag, retry attribution (`attempt_number` + `retry_reason`), `is_test` flag, server-derived `cost_source` + `pricing_version`. Dashboard: Workflow Treemap + workflow detail page + Customers page + Waste Inbox + Cost Confidence card. |
| **v0.3.1** | Gemini SDK support; productized rollup backfill UX (the manual repair script `scripts/backfill-llm-metrics-hourly.sh` ships today) |
| **v0.4.x** | OpenTelemetry GenAI bridge; configurable alert channels |
| **v0.5.0** | Native LangChain + LlamaIndex framework integrations (Python + TypeScript) |
| **v0.6.0** | Budget enforcement — alert, soft-block, model fallback |
| **v0.7.0** | Agent execution debugger — visual step tree for multi-step agents |

---

## Self-hosting

Full self-hosting is a first-class target. The Docker Compose stack in this repo is the same stack we run in production. Minimum requirements: 4 vCPU, 8 GB RAM, 100 GB disk (for ClickHouse).

See [scopecall.com/docs/self-hosting](https://scopecall.com/docs/self-hosting) for production hardening, Kubernetes manifests, and environment variable reference.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). No CLA required.

---

## Security

See [SECURITY.md](SECURITY.md) or email security@scopecall.com.

---

## License

[Apache 2.0](LICENSE). Free to self-host, modify, redistribute, or build commercial products on top of. We monetize via the managed-cloud product and enterprise features — not via licensing restrictions.
