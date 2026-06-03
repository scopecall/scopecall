# ScopeCall

Source-available, self-hostable AI observability. See every call your AI makes, track what it costs, and trace what went wrong — without routing traffic through a proxy.

ScopeCall captures LLM traces via SDK instrumentation (no added latency, no proxy) — OpenAI, Anthropic, and the Vercel AI SDK at v0.1.1 — ships the events to a self-hosted ClickHouse + Postgres stack, and displays them in a real-time dashboard with cost / latency / prompt-version breakdowns. Budget enforcement and an agent execution debugger are on the roadmap.

Licensed under [BUSL-1.1](LICENSE) — free for any internal use; we just ask that you not resell it as a managed service. The license converts to Apache-2.0 four years after each release.

[![Version](https://img.shields.io/badge/version-v0.1.1-6366f1)](https://github.com/scopecall/scopecall/releases/tag/v0.1.1)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-docs.scopecall.com-informational)](https://docs.scopecall.com)

---

## What ships in v0.1.1

- TypeScript SDK with OpenAI (`chat.completions.create`), Anthropic
  (`messages.create`), and Vercel AI SDK (`generateText` / `streamText` /
  `generateObject` / `streamObject`) instrumentation — streaming + non-streaming.
- Persisted workflow spans (`sdk.trace()`) so the trace tree + Flow Map
  show real parent → child structure, not flat call lists.
- Server-authoritative pricing — the Rust processor recomputes `cost_usd`
  from a bundled pricing table; SDK-supplied cost is advisory.
- Per-prompt-version analytics (`/dashboard/prompts`).
- Self-hosted stack via Docker Compose (Rust ingest, Go API, Next.js
  dashboard, ClickHouse, Postgres, Redpanda, Redis).
- Email + password auth (Auth.js); dead-letter queue with retry.

**Not yet in v0.1.1:** Gemini support (v0.1.2), OpenTelemetry bridge
(v0.2.x), native LangChain / LlamaIndex integrations (v0.3.0; the
manual `record_llm_call(...)` API works today as a bridge), budget
enforcement / model fallback (v0.4.0), agent execution debugger
(v0.5.0). See [roadmap](#roadmap) below.

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

### 3. Install the TypeScript SDK

```bash
npm install @scopecall/scopecall-js
```

### 4. Instrument OpenAI

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

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
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
| **v0.1.1** *(current)* | Anthropic + Vercel AI SDK support; workflow spans; per-prompt-version analytics; API key management; durable processor offsets. **Python SDK** (`scopecall-py@0.2.0`) ships alongside with OpenAI + Anthropic sync/async/streaming instrumentation and a manual `record_llm_call(...)` API for LangChain / LlamaIndex / custom wrappers. |
| **v0.1.2** | Gemini SDK support; productized rollup backfill UX (the manual repair script `scripts/backfill-llm-metrics-hourly.sh` ships in v0.1.1) |
| **v0.2.x** | OpenTelemetry GenAI bridge; configurable alert channels |
| **v0.3.0** | Native LangChain + LlamaIndex framework integrations (Python + TypeScript) |
| **v0.4.0** | Budget enforcement — alert, soft-block, model fallback |
| **v0.5.0** | Agent execution debugger — visual step tree for multi-step agents |

---

## Self-hosting

Full self-hosting is a first-class target. The Docker Compose stack in this repo is the same stack we run in production. Minimum requirements: 4 vCPU, 8 GB RAM, 100 GB disk (for ClickHouse).

See [docs.scopecall.com/self-hosting](https://docs.scopecall.com/self-hosting) for production hardening, Kubernetes manifests, and environment variable reference.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). No CLA required.

---

## Security

See [SECURITY.md](SECURITY.md) or email security@scopecall.com.

---

## License

[BUSL-1.1](LICENSE) — free to self-host for internal use. Managed hosting for third parties requires a commercial agreement. Converts to Apache 2.0 on May 26, 2031.
