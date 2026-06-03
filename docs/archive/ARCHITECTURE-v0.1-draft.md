# ScopeCall — Architecture (v0.1 draft, archived)

> **⚠️ Archived. Do not rely on this document.**
>
> This is the long-form architecture writeup from the v0.1 development
> cycle. Parts of it describe surfaces that were planned but never
> shipped (Python SDK, LangChain via OpenLLMetry, OpenAI Python SDK,
> Anthropic Python SDK) and some sections use ports and SDK shapes that
> have since changed.
>
> Authoritative current architecture: [`/ARCHITECTURE.md`](../../ARCHITECTURE.md)
> at the repo root.
> Authoritative roadmap: [`/docs/roadmap.md`](../roadmap.md).
>
> This file is kept for historical context and for anyone debugging
> upgrade paths from v0.1.0 → v0.1.1. Treat any contradiction with the
> root ARCHITECTURE.md or roadmap.md as this file being wrong.

This document describes the technical architecture of ScopeCall. For installation and quick-start, see the [README](README.md). For SDK design and API reference, see [SDK_DESIGN.md](SDK_DESIGN.md).

---

## What ScopeCall Does

```
AI makes a decision           → captured as a trace event
Cost adds up                  → tracked per call, per feature, per model
LLM throws an error           → recorded with full context
Tool gets called              → instrumented and timed
Streaming completes           → TTFT + total latency captured
```

ScopeCall instruments your AI SDK calls via lightweight library wrapping (no proxy, no added latency in your critical path), ships events to a self-hosted ingest pipeline, stores them in ClickHouse, and serves them through a query API + dashboard.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Customer AI App                          │
│                                                                 │
│   import scopecall                                                 │
│   scopecall.init(api_key="xxx")   ← one line                      │
│                                                                 │
│   # Everything below is automatic                               │
│   openai.chat.completions.create(...)   ← intercepted          │
│   anthropic.messages.create(...)        ← intercepted          │
│   langchain.invoke(...)                 ← intercepted          │
└───────────────────┬─────────────────────────────────────────────┘
                    │ HTTPS (async, batched, non-blocking)
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ScopeCall Platform                            │
│                                                                 │
│  Ingest API → Redpanda → Stream Processor → ClickHouse          │
│                                    ↓                            │
│                          Query API (Go)                         │
│                                    ↓                            │
│                         Dashboard (Next.js)                     │
│                                    ↓                            │
│                          AI Analysis Layer                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Current Architecture (v0.1.0)

### Goal
Solve one pain completely: visibility into what your AI is doing and what it costs.

Capture every LLM call. Show traces, tokens, and costs in real-time. Self-host in 10 minutes.

---

### Layer 1 — SDK

The most important piece. Must be:
- One line to initialize
- Zero configuration for immediate value
- Auto-instruments all major AI libraries
- Async — never slows down the customer app
- Works in Python and TypeScript day one

#### Python SDK

```python
# Full integration
import scopecall
scopecall.init(api_key="sc_live_xxx")

# Now automatic — no other changes needed
response = openai.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "hello"}]
)
# Every call captured: model, tokens, cost, latency, prompt, response
```

#### TypeScript SDK

```typescript
// Full integration
import { ScopeCall } from '@scopecall/scopecall-js'
ScopeCall.init({ apiKey: 'sc_live_xxx' })

// Auto-instruments: OpenAI, Anthropic, LangChain, Vercel AI SDK
```

#### What The SDK Captures Per LLM Call

```
trace_id          → unique ID linking related calls
timestamp         → when the call happened
model             → gpt-4, claude-3-sonnet, gemini-pro, etc.
provider          → openai, anthropic, google, etc.
input_tokens      → prompt token count
output_tokens     → completion token count
cost_usd          → calculated from tokens × model pricing table
latency_ms        → time to first token + total time
status            → success / error / timeout / rate_limited
input_text        → full prompt (redacted if PII detected)
output_text       → full response
error_message     → if failed, why
feature_name      → developer-tagged: "search", "chat", "summary"
user_id           → which end user triggered this (optional)
environment       → prod / staging / dev
```

#### How Auto-Instrumentation Works

```python
# SDK wraps the library at import time (monkey-patching)
# Developer code never changes
# SDK intercepts → records → lets call proceed → records result
# All sending is async in background thread
# If ScopeCall servers are down → call proceeds normally, data dropped gracefully
```

#### Supported Libraries — MVP

```
OpenAI Python SDK         ✓
Anthropic Python SDK      ✓
OpenAI Node.js SDK        ✓
Anthropic Node.js SDK     ✓
LangChain Python          ✓  (via OpenLLMetry)
LangChain JS              ✓  (via OpenLLMetry)
```

#### Built On OpenLLMetry

Rather than maintaining instrumentation from scratch, SDK wraps OpenLLMetry:
- OpenLLMetry already instruments 20+ frameworks
- When LangChain releases breaking changes, OpenLLMetry fixes it
- We inherit fixes automatically
- Our SDK adds: batching, cost calculation, PII redaction, ScopeCall-specific enrichment

---

### Layer 2 — Ingest Pipeline

```
SDK  →  HTTPS POST (batched every 5 seconds)
              ↓
         Load Balancer
              ↓
       Ingest Service (Rust)
       ├── Authenticate API key
       ├── Validate + parse events (JSON in from SDK)
       ├── Enrich (server timestamp, org resolution)
       ├── PII scan + redact (defense-in-depth — SDK already redacts)
       └── Push to Redpanda (Protobuf binary, internal format)
              ↓
          Redpanda
          ├── Buffers traffic spikes
          ├── Guarantees no data loss
          ├── Decouples ingest from storage
          └── Replay if downstream fails
              ↓
       Stream Processor (Rust)
       ├── Decode Protobuf event
       ├── Calculate exact cost per call
       ├── Compute rolling metrics
       ├── Detect simple anomalies (cost spike, error spike — basic rules)
       └── Write to ClickHouse (native protocol via clickhouse-rs)
              ↓
          ClickHouse
```

#### Why Redpanda Over Kafka

```
Kafka       → requires ZooKeeper, complex ops, 6+ JVM processes
Redpanda    → single binary, Kafka-compatible API, 10x simpler to operate
             → you get Kafka reliability without Kafka operational overhead
```

#### Why Rust For Ingest + Stream Processor (Hot Path Only)

Rust is contained to the two hot-path services. Everything else (query API, workers,
billing) is in Go. This matches the actual industry pattern (Sentry, Datadog, Discord
all contain Rust to specific hot paths, not their whole stack).

```
Higher throughput   → handles 10k-100k+ events/sec per node
                      ~1.5-2x more events per CPU core vs Go
                      (real gains, but smaller than micro-benchmark claims)
Lower memory        → typically 50-70% of Go's memory footprint
                      direct OpEx savings at scale
No GC pauses        → deterministic latency, better P99/P999 tail latency
Memory safety       → no segfaults, no data races in our Rust code at compile time
                      (note: rdkafka has C dependency — see Honest Trade-offs below)
Single binary       → small distroless containers (~20-40MB including rdkafka)

Industry precedent (honest version):
├── Sentry's Relay (ingest) is Rust — written 2018+ after years of Python pain
├── Datadog's Vector (pipeline tool) is Rust
├── Cloudflare's edge runtime + DDoS detection is Rust
└── Discord's Read States hot path is Rust

What's NOT precedent: starting an entire backend stack in Rust from day one.
ScopeCall starts the hot path in Rust and keeps everything else in Go/Python/TS,
matching the actual industry pattern.
```

**Honest Trade-offs**:
```
- rdkafka is a C library wrapper. "Memory safety at compile time" applies to our
  Rust application code, not to the Kafka client transport. Acceptable trade-off
  given pure-Rust alternatives (rskafka) lack features we need.
- Cold start for production Rust services with tokio + connection pools + tracing
  init is 300ms-2s, not the "sub-100ms" of hello-world binaries.
- Memory savings vs Go are typically 50-70% in production (not the 30-50% claim
  earlier drafts had — that was cherry-picked benchmark numbers).
```

---

### Layer 3 — ClickHouse Schema

```sql
-- Primary table: every AI call ever made
CREATE TABLE llm_calls (
    -- Identity
    trace_id        UUID,
    span_id         UUID,
    org_id          UUID,
    project_id      UUID,

    -- Time
    timestamp       DateTime64(3),

    -- AI specifics
    model           LowCardinality(String),
    provider        LowCardinality(String),
    input_tokens    UInt32,
    output_tokens   UInt32,
    cost_usd        Float32,
    latency_ms      UInt32,
    status          LowCardinality(String),

    -- Content (compressed automatically by ClickHouse)
    input_text      String,
    output_text     String,
    error_message   String,

    -- Context
    feature_name    LowCardinality(String),
    user_id         String,
    environment     LowCardinality(String),
    sdk_version     LowCardinality(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (org_id, project_id, timestamp)
TTL timestamp + INTERVAL 90 DAY;  -- configurable per plan

-- Pre-aggregated hourly rollups (fast dashboard queries)
-- Uses AggregatingMergeTree with state-storing aggregate functions
-- so percentiles and averages merge correctly across parts.
CREATE TABLE llm_metrics_hourly (
    org_id          UUID,
    project_id      UUID,
    hour            DateTime,
    model           LowCardinality(String),
    feature_name    LowCardinality(String),

    -- Summable counters (these are SAFE to use SimpleAggregateFunction(sum, ...))
    total_calls     SimpleAggregateFunction(sum, UInt64),
    total_cost_usd  SimpleAggregateFunction(sum, Float64),
    error_count     SimpleAggregateFunction(sum, UInt64),
    total_tokens    SimpleAggregateFunction(sum, UInt64),

    -- Latency aggregates — use State() functions, merged with -Merge() at query time
    -- This is the critical fix vs SummingMergeTree, which would literally SUM
    -- the per-row "averages" together and produce garbage.
    latency_avg_state    AggregateFunction(avg, UInt32),
    latency_p99_state    AggregateFunction(quantile(0.99), UInt32),
    latency_p50_state    AggregateFunction(quantile(0.50), UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (org_id, project_id, hour, model, feature_name)
TTL hour + INTERVAL 1 YEAR;

-- Dashboard reads these via -Merge() functions:
--   SELECT
--       hour,
--       sum(total_cost_usd)                       AS cost,
--       avgMerge(latency_avg_state)               AS avg_latency_ms,
--       quantileMerge(0.99)(latency_p99_state)    AS p99_latency_ms
--   FROM llm_metrics_hourly
--   WHERE org_id = ? AND project_id = ? AND hour >= ?
--   GROUP BY hour
--   ORDER BY hour;

-- Materialized view that populates llm_metrics_hourly from llm_calls.
-- CRITICAL: uses -State() functions to write into AggregateFunction columns.
-- Without these, AggregatingMergeTree won't merge correctly.
CREATE MATERIALIZED VIEW llm_metrics_hourly_mv
TO llm_metrics_hourly
AS SELECT
    org_id,
    project_id,
    toStartOfHour(timestamp) AS hour,
    model,
    feature_name,

    -- Summable counters use sumState
    sum(1)                           AS total_calls,
    sum(cost_usd)                    AS total_cost_usd,
    sumIf(1, status != 'success')    AS error_count,
    sum(input_tokens + output_tokens) AS total_tokens,

    -- Latency aggregates use the matching -State() functions
    avgState(latency_ms)             AS latency_avg_state,
    quantileState(0.99)(latency_ms)  AS latency_p99_state,
    quantileState(0.50)(latency_ms)  AS latency_p50_state

FROM llm_calls
GROUP BY org_id, project_id, hour, model, feature_name;

-- Dashboard reads with -Merge() on the State() columns; sums and counts read directly.

-- Agent execution traces
CREATE TABLE agent_traces (
    trace_id        UUID,
    org_id          UUID,
    project_id      UUID,
    timestamp       DateTime64(3),
    total_steps     UInt16,
    total_cost_usd  Float32,
    total_latency_ms UInt32,
    status          LowCardinality(String),
    steps           String CODEC(ZSTD(3))   -- JSON array of steps, compressed
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (org_id, project_id, timestamp)
TTL timestamp + INTERVAL 90 DAY;

-- AI Layer output tables (future, written by Python AI Layer)
CREATE TABLE anomalies (
    org_id          UUID,
    project_id      UUID,
    detected_at     DateTime64(3),
    anomaly_type    LowCardinality(String),  -- cost_spike / error_spike / latency_spike / new_error_pattern
    severity        LowCardinality(String),  -- info / warning / critical
    metric_name     LowCardinality(String),
    baseline_value  Float64,
    observed_value  Float64,
    z_score         Float32,
    metadata        String                   -- JSON: window, sample traces, etc.
)
ENGINE = MergeTree()
ORDER BY (org_id, project_id, detected_at);

CREATE TABLE quality_scores (
    trace_id        UUID,
    org_id          UUID,
    project_id      UUID,
    scored_at       DateTime64(3),
    score           UInt8,                   -- 0-100
    reasoning       String CODEC(ZSTD(3)),   -- LLM judge's reasoning
    feature_name    LowCardinality(String)
)
ENGINE = MergeTree()
ORDER BY (org_id, project_id, scored_at);
```

> **Note**: `budget_rules`, `api_keys`, `orgs`, `users`, `projects`, and `memberships`
> live in **Postgres**, not ClickHouse. ClickHouse is OLAP — it's
> wrong for transactional CRUD that the dashboard does when admins create/edit rules.
> Postgres schemas are in `schemas/postgres/` (separate migration system).

#### Key Design Decisions

```
Partitioning by month     → old data stays queryable, hot data on SSD
LowCardinality strings    → model names, providers compress 10x better
AggregatingMergeTree      → percentiles and averages merge CORRECTLY across parts
                            (SummingMergeTree would produce garbage for avg/p99)
ZSTD(3) on JSON columns   → 3-5x compression for prompt text + agent step blobs
TTL on raw data           → automatic cleanup, storage cost control
JSON for agent steps      → flexible schema for variable agent structures
```

#### Tenant Isolation

Multi-tenant isolation is enforced at TWO layers:

```
1. Application layer (primary)
   ├── Every query API handler resolves org_id from JWT/API key
   ├── Every ClickHouse query includes org_id in WHERE clause
   ├── Query API rejects requests without resolved org_id
   └── Cannot be bypassed by user input (org_id never comes from request body)

2. ClickHouse layer (defense-in-depth, future)
   ├── Per-org ClickHouse user accounts with row-level security policies
   ├── ROW POLICY org_isolation ON llm_calls
   │   USING org_id = currentUser()::UUID TO ALL
   ├── Enforced by ClickHouse server, not by application code
   └── Catches application bugs (forgot WHERE org_id = ?)
```

The second layer is critical for enterprise security reviews. App-layer isolation
alone is "we promise our code is correct" — ClickHouse-level isolation is enforced
by the server regardless of application bugs.

---

### Layer 4 — Query API

```
Dashboard  ──┐
             ├──→  Query API (Go)  ──→  ClickHouse + Postgres
Customer   ──┘
REST API

Responsibilities:
├── JWT authentication
├── Org/project scoping (tenant isolation)
├── Query building from dashboard filters
├── Redis caching for repeated queries
├── Rate limiting
└── PII masking based on org settings
```

#### Core Endpoints — MVP

```
GET  /v1/overview              → summary metrics for dashboard home
GET  /v1/traces                → paginated list of LLM calls
GET  /v1/traces/:id            → single trace with full content
GET  /v1/metrics/cost          → cost over time, grouped by model/feature
GET  /v1/metrics/latency       → latency percentiles over time
GET  /v1/metrics/errors        → error rates and top errors
GET  /v1/alerts                → active anomaly alerts
POST /v1/budgets               → create cost budget rule
```

---

### Layer 5 — Dashboard

Supabase Studio equivalent. This is the product developers fall in love with.

#### Home — Overview
```
┌─────────────────────────────────────────────────────┐
│  Total Cost This Month    Calls Today    Error Rate  │
│  $1,243  ↑12%             48,291         0.3%        │
├─────────────────────────────────────────────────────┤
│  Cost Over Time (7 days)                            │
│  [chart]                                            │
├──────────────────┬──────────────────────────────────┤
│  By Model        │  By Feature                      │
│  GPT-4   $890   │  Search    $640                   │
│  Claude  $280   │  Chat      $480                   │
│  Gemini  $73    │  Summary   $123                   │
└──────────────────┴──────────────────────────────────┘
```

#### Trace Explorer
```
┌─────────────────────────────────────────────────────┐
│  Search traces...          Filter: model, status    │
├─────────────────────────────────────────────────────┤
│  Timestamp      Model    Cost    Latency   Status   │
│  12:43:21 PM    gpt-4    $0.02   1.2s      ✓        │
│  12:43:18 PM    claude   $0.01   0.8s      ✓        │
│  12:43:15 PM    gpt-4    $0.00   -         ✗ error  │
├─────────────────────────────────────────────────────┤
│  TRACE DETAIL (click any row)                       │
│  ├── Input: "Summarize the following article..."    │
│  ├── Output: "The article discusses..."             │
│  ├── Tokens: 1,240 in / 380 out                    │
│  ├── Cost: $0.0194                                  │
│  └── Latency: 1,243ms                              │
└─────────────────────────────────────────────────────┘
```

#### Cost Control
```
┌─────────────────────────────────────────────────────┐
│  Budget Rules                          + Add Rule   │
├─────────────────────────────────────────────────────┤
│  Project / daily / $100 → alert        ✓ Active     │
│  Feature: search / hourly / $20 → block ✓ Active    │
│  Model: gpt-4 / monthly / $500 → alert  ✓ Active    │
├─────────────────────────────────────────────────────┤
│  Forecast                                           │
│  At current rate: $1,890 end of month               │
│  Budget: $1,500                                     │
│  ⚠ Will exceed budget in 8 days                    │
└─────────────────────────────────────────────────────┘
```

#### Alerts
```
┌─────────────────────────────────────────────────────┐
│  🔴 CRITICAL  Cost spike 4x normal — last 30 min    │
│  🟡 WARNING   Error rate 2.1% (threshold: 2%)       │
│  🟢 RESOLVED  Latency spike — resolved 10 min ago   │
└─────────────────────────────────────────────────────┘
```

---

### MVP Technology Stack

```
SDK (Python)          Python, wraps OpenLLMetry
SDK (TypeScript)      TypeScript, wraps OpenLLMetry

Hot path (Rust):
├── Ingest Service       axum + tokio + rdkafka
└── Stream Processor     tokio + rdkafka consumer + clickhouse-rs writer

Warm path (Go):
├── Query API            chi + clickhouse-go/v2 + go-redis + JWT
├── Background Workers   scheduled jobs (pricing refresh, cleanup)
└── Billing Service      (future) Stripe webhooks + Postgres

AI Layer (Python):
└── Batch jobs reading ClickHouse, writing results back to ClickHouse
    (anomaly detection, NL queries, quality scoring)

Message Queue         Redpanda (Kafka-compatible)
Analytics Storage     ClickHouse Cloud (managed, OLAP — events/metrics/traces)
Transactional Storage Supabase Cloud (Postgres) — orgs, users, API keys, billing
Cache                 Redis (Upstash for managed)
Dashboard             Next.js 14, Tailwind CSS, shadcn/ui
Auth (Cloud)          Supabase Auth
Auth (Self-Hosted)    Auth.js + lightweight Postgres
Hosting (Cloud)       Railway/Fly.io (backend) + Vercel (dashboard)
Hosting (Self-Host)   Docker Compose (single host) or Kubernetes (at scale)
```

**Language stack rationale**: Four languages, each scoped to its strongest domain.
Rust is contained to the hot path only — the same pattern Sentry/Datadog/Discord follow
in production.

**Schema management**: Protobuf for wire formats and storage row mirrors,
ClickHouse DDL as source of truth for storage layout, OpenAPI/TypeSpec for the
dashboard API. CI lint enforces DDL ↔ .proto consistency.

---

### MVP Feature Scope

```
✓  Python SDK with auto-instrumentation
✓  TypeScript SDK with auto-instrumentation
✓  Supports: OpenAI, Anthropic, LangChain
✓  Real-time cost tracking per call
✓  Trace explorer (list + detail view)
✓  Cost dashboard (by model, by feature, over time)
✓  Basic alerting (cost spike, error spike)
✓  Budget rules (alert when limit exceeded)
✓  Self-hosted option (Docker Compose)
✓  Cloud hosted option (managed by ScopeCall)
✗  Agent visual debugger (planned)
✗  AI anomaly detection (planned)
✗  Natural language queries (planned)
✗  Quality scoring (planned)
✗  SSO / SAML (planned)
```

---

## Schema & Type System

ScopeCall has three distinct schema domains, each with its own source of truth.
Three sources, narrow scopes, one CI lint binding them together.

```
┌───────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  WIRE FORMAT EVENTS              schemas/events/*.proto               │
│  (SDK → Ingest → Redpanda)       SOURCE OF TRUTH: Protobuf            │
│                                  CODEGEN → Python, Rust, Go, TS       │
│                                                                       │
│  CLICKHOUSE STORAGE ROWS         schemas/clickhouse/*.sql             │
│  (Rust writes, Go API reads,     SOURCE OF TRUTH: DDL                 │
│   Python AI Layer reads)         MIRROR: schemas/storage/*.proto      │
│                                  CI LINT: field names + types match   │
│                                  CODEGEN → Go, Python row types       │
│                                                                       │
│  DASHBOARD API CONTRACT          schemas/api/scopecall-api.tsp           │
│  (Query API → Dashboard)         SOURCE OF TRUTH: OpenAPI/TypeSpec    │
│                                  CODEGEN → TS types + Swagger UI      │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Why Three Sources, Not One

ClickHouse has things Protobuf cannot natively express:
```
LowCardinality(String)          — encoding-level, not a type
Nullable(T)                     — proto3 optional semantics differ
AggregateFunction(quantile, …)  — no Protobuf equivalent
Materialized columns            — purely DDL concept
CODEC(ZSTD(3)), TTL, PARTITION  — purely DDL concept
```

Forcing Protobuf to be "1:1 with the table" creates two sources that always
disagree on the edges. Cleaner factoring:
- DDL owns storage layout (codecs, TTLs, sorting keys, partitions, codec configs)
- `.proto` mirrors *field name + primitive type* so Go/Python row deserialization
  has typed structs to read into
- The CI lint validates names + primitive types match. It does NOT try to validate
  ClickHouse-specific modifiers

### Wire Format Philosophy

```
JSON at edges (where humans debug):
├── SDK → Ingest HTTPS POST   (developers can curl, no Protobuf knowledge required)
└── Query API → Dashboard      (Next.js consumes JSON natively)

Protobuf in the middle (where machines optimize):
├── Ingest → Redpanda topics  (binary, compact, fast)
└── Stream Processor → ClickHouse (native ClickHouse protocol)
```

### Tooling

```
buf                  → linting, breaking-change detection, codegen orchestration
protoc-gen-python    → Python types (used by SDK + AI Layer)
prost + prost-build  → Rust types (used by ingest + processor)
protoc-gen-go        → Go types (used by query API + workers)
ts-proto             → TypeScript types (used by dashboard events)
openapi-typescript   → TypeScript types from OpenAPI (used by dashboard API)
sqlglot              → DDL parser for the CI lint
```

---

## Python AI Analysis Layer Architecture

The AI Analysis Layer is a separate Python service that runs batch and scheduled
jobs. It does NOT participate in the synchronous hot path. It does NOT use gRPC.
It communicates with the rest of the system through ClickHouse-as-bus.

### Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Rust Stream Processor writes raw events to ClickHouse           │
│       ↓                                                          │
│  Python AI Layer (separate deployable, scheduled jobs):          │
│       ├── Anomaly Detection job (hourly)                         │
│       │   ├── Reads recent traces from llm_calls                 │
│       │   ├── Computes baseline + z-scores                       │
│       │   └── Writes results to anomalies table                  │
│       │                                                          │
│       ├── Quality Scoring job (5min)                             │
│       │   ├── Samples 5% of recent traces                        │
│       │   ├── Uses Claude as judge with calibration examples     │
│       │   └── Writes scores to quality_scores table              │
│       │                                                          │
│       └── NL Query handler (on-demand from API)                  │
│           ├── Receives NL query via Redis queue from Go API      │
│           ├── Translates to SQL using Claude                     │
│           ├── Executes against ClickHouse                        │
│           └── Returns result via Redis pub/sub                   │
│       ↓                                                          │
│  Go Query API reads AI Layer outputs from ClickHouse             │
│  Dashboard displays them as part of normal data views            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Why Not gRPC

The AI workload is fundamentally batch-scheduled:
- Anomaly detection runs hourly on rolling windows
- Quality scoring samples async
- Model comparison accumulates over 7 days
- NL queries are user-triggered with a few seconds of acceptable latency

None of these workloads need sub-100ms synchronous response from the AI Layer.
ClickHouse-as-bus is sufficient and dramatically simpler:
- One less protocol to maintain
- No service mesh / load balancing for AI Layer
- AI Layer can be down for hours without affecting ingest/queries
- Easier to scale AI Layer independently (k8s CronJob vs long-lived service)
- Simpler self-hosted story (one less moving piece in docker-compose)

### Coordination

Redis serves as the locking layer:
```
Anomaly detection job lock:    redis.SET anomaly_job:{org_id} 1 EX 3600 NX
                               (prevents two anomaly runs at the same time)

NL query request/response:     Redis Streams or pub/sub
                               (Go API publishes, Python AI Layer consumes,
                                publishes back, Go API resolves response)
```

Redis is already in the stack for Query API caching, so no new infra.

### Tables The AI Layer Writes To

```
anomalies              Detected anomalies with metadata
quality_scores         Per-trace LLM-as-judge quality scores
nl_query_log           NL → SQL translations (cached for repeated queries)
model_comparisons      Multi-model A/B comparison results (planned)
```

These tables are read-only from the Rust/Go services' perspective. Only the AI Layer
writes to them.

---

## Future Architecture

> Sections below describe planned capabilities. Specific release timing is in the [roadmap](docs/roadmap.md) or the [CHANGELOG](CHANGELOG.md).

### What This Section Covers

Future work builds on the same foundation. No rewrites. Add layers on top.

---

### New Layer: Agent Debugger

Visual execution tree for multi-step AI agents.

```
Agent Execution Timeline
─────────────────────────────────────────────────────
00:00  User query received: "Book me a flight to NYC"
  │
00:12  Tool call: search_flights(from="SFO", to="JFK")
  │    └── returned 12 results
  │
00:89  LLM call: gpt-4 (filter and rank results)
  │    └── 340 tokens, $0.006, 780ms
  │
01:20  Tool call: check_price(flight_id="AA_123")
  │    └── returned $340
  │
01:45  LLM call: gpt-4 (generate response)
  │    └── 180 tokens, $0.003, 420ms
  │
01:92  Response delivered to user

Total: 4 steps, 1.92 seconds, $0.009
```

**Technical implementation:**
- SDK captures parent/child span relationships (standard OpenTelemetry trace model)
- Query API reconstructs tree from span data
- Dashboard renders as interactive timeline
- Click any step to see full input/output

---

### New Layer: AI Analysis Engine

Uses Claude API to analyze patterns across traces.

```
Anomaly Detection
├── Baseline: calculate rolling 7-day average per metric
├── Spike detection: alert if current > 3x baseline
├── New pattern detection: cluster errors, flag new clusters
└── Correlation: "cost spike correlates with deploy at 2pm"

Quality Scoring (LLM-as-judge)
├── Sample 5% of responses automatically
├── Claude scores each: relevance, completeness, accuracy
├── Aggregate quality score per feature over time
├── Alert if quality drops below threshold

Natural Language Query
├── Developer types: "why did costs spike on Tuesday?"
├── Claude translates to ClickHouse SQL
├── Execute query, fetch results
├── Claude summarizes results in plain English
└── Returns: "Cost spiked 4x between 2-4pm Tuesday,
            driven by 890 calls to gpt-4 from the
            search feature, likely caused by the
            prompt change deployed at 1:47pm"
```

---

### New Layer: Multi-Model Intelligence

```
Model Comparison
├── Same prompt, different models — compare cost/quality/latency
├── "If you switched search from GPT-4 to Claude Haiku
    you'd save $800/month with 94% quality retention"

Model Routing (automatic)
├── Route to cheaper model when quality threshold is met
├── Fallback to stronger model when cheaper model fails
└── Budget-aware routing: switch models as budget limit approaches
```

---

### Future Technology Additions

```
AI Analysis Engine    Claude API (Sonnet for analysis, Haiku for classification)
Vector Storage        pgvector (similarity search for trace clustering)
Background Jobs       Temporal (durable scheduled analysis jobs)
Websockets            Real-time dashboard updates without polling
```

---

### Future Feature Scope

```
✓  Agent visual debugger
✓  AI-powered anomaly detection
✓  Natural language query ("why did X happen?")
✓  Quality scoring (LLM-as-judge)
✓  Model comparison and switching recommendations
✓  Multi-model routing with fallback
✓  SSO / SAML (Okta, Google Workspace)
✓  RBAC (admin / developer / viewer roles)
✓  Audit logs (who did what, when)
✓  Data retention policies per project
✓  Webhook integrations (Slack, PagerDuty)
✓  SOC2 Type 1 certification
✗  On-premise deployment (planned)
✗  SOC2 Type 2 (planned)
✗  Custom ML models for anomaly detection (planned)
```

---

## Deployment Architecture

### Self-Hosted (BUSL-1.1, source-available)

```
docker-compose up

Services:
├── scopecall-ingest     (Rust, port 4317)
├── scopecall-processor  (Rust, no exposed port)
├── scopecall-api        (Go,   port 8080)
├── scopecall-workers    (Go,   no exposed port)
├── scopecall-ai-layer   (Python, batch jobs, no exposed port)
├── scopecall-dashboard  (Next.js, port 3000)
├── postgres          (port 5432 — orgs/users/API keys/billing, lightweight)
├── redpanda          (port 9092)
├── clickhouse        (port 8123)
└── redis             (port 6379)

Requirements:
├── 4 CPU cores minimum
├── 16GB RAM minimum
├── 500GB SSD for 30 days retention at moderate volume
```

### Managed Cloud

```
Customer app → scopecall.com ingest endpoint
                      ↓
              Shared Redpanda cluster
                      ↓
              ClickHouse Cloud (tenant-isolated)
                      ↓
              Shared Query API (org-scoped)
                      ↓
              dashboard.scopecall.com (per-org subdomain)
```

**Tenant isolation in ClickHouse:**
Every query is scoped by `org_id` at the query API level.
Customers cannot see each other's data.
Row-level security enforced at ClickHouse level as secondary control.

---

## Security Architecture

```
In Transit        TLS 1.3 everywhere, no HTTP

At Rest
├── ClickHouse Cloud:  encryption at rest enabled by default (AES-256)
├── Self-hosted OSS:   responsibility of the operator (configure disk encryption)
│                       ScopeCall documents but does not enforce this
└── Postgres:           managed by Supabase / operator

API Auth
├── SDK → Ingest:      API key (Bearer token), TLS-encrypted in transit
├── Dashboard → API:   JWT (issued by Supabase Auth / Auth.js)
└── Internal RPC:      not applicable (no inter-service RPC; ClickHouse-as-bus pattern)

Tenant Isolation (two layers, defense-in-depth)
├── Application layer: org_id resolved from auth, included in every query
└── ClickHouse layer:  ROW POLICY per-org user (future, enterprise tier)

PII Redaction
├── SDK-level:         regex-based (email, phone, card, SSN, IP)
│                       Runs in-process BEFORE network transmission
├── Ingest-level:      defense-in-depth pass (catches missed PII)
└── Mode:              capture_content=false available for max privacy
                       (sends only metadata: tokens, cost, latency, model)

Key Management
├── Current:           Standard TLS + encrypted at-rest storage
└── Future: Customer-managed encryption keys (CMK)

Audit Logging
├── All dashboard mutations logged with actor + timestamp
├── All API key usage logged (last-used timestamp updated)
└── Logs stored in Postgres (transactional), not ClickHouse (analytical)
```

---

## See Also

- [README.md](README.md) — quickstart and overview
- [CHANGELOG.md](CHANGELOG.md) — what shipped in each release
- [docs/roadmap.md](docs/roadmap.md) — current and upcoming work
- [docs/self-hosting.md](docs/self-hosting.md) — production deployment guide
- [SDK_DESIGN.md](SDK_DESIGN.md) — SDK design and instrumentation reference
- [SECURITY.md](SECURITY.md) — security policy and disclosure

---

