# Changelog

All notable changes to ScopeCall are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## Python SDK — [0.2.0] — 2026-06-03

Full rewrite for TypeScript-SDK parity. The v0.1 Python SDK relied on
Traceloop/OpenLLMetry; v0.2 is a direct-monkey-patch implementation
that matches the TS SDK's wire format and ergonomics. Several breaking
changes — see the migration note at the bottom.

### Added

- Native OpenAI instrumentation — `sdk.instrument(OpenAI())` or
  `sdk.instrument(AsyncOpenAI())`. Auto-detects sync vs async. Wraps
  `chat.completions.create` with full streaming + TTFT + auto
  `stream_options.include_usage=True` support.
- Native Anthropic instrumentation — `sdk.instrument(Anthropic(), "anthropic")`
  or `sdk.instrument(AsyncAnthropic(), "anthropic")`. Same shape;
  handles Anthropic's stream-event types (`message_start` /
  `content_block_delta` / `message_delta`).
- Workflow-span emission — `sdk.trace(name)` blocks emit a synthetic
  `kind='workflow'` event on exit, matching the TS SDK's Round-3 P0
  contract. Children inside the block reference the workflow's
  `span_id` as their `parent_span_id`.
- `sdk.workflow(name)` alias of `sdk.trace(name)` (matches the
  reviewer's example shape).
- `sdk.span(name)` — **experimental, do not use in new code.** Chains
  `parent_span_id` without emitting a row, which orphans children in
  the dashboard's trace tree. Use nested `sdk.trace(name)` blocks
  instead. Scheduled for removal in v0.3.0. Calls now emit a
  `DeprecationWarning` on first invocation per SDK instance.
- `sdk.record_llm_call(...)` — manual escape hatch for LangChain /
  LlamaIndex / RAG / custom wrappers. Reads the current trace context
  to chain `parent_span_id` + inherit feature / user / session /
  prompt_version.
- `default_prompt_version` config option (matches TS SDK).
- `contextvars`-based trace propagation across `await` and
  `asyncio.create_task()` — first-class FastAPI / async-worker
  support.
- PII redactor applied symmetrically to `input_text` and `output_text`.
- FastAPI example (`sdks/python/examples/fastapi/`).
- CI matrix across Python 3.10 / 3.11 / 3.12 / 3.13 with ruff + mypy
  strict.
- PyPI trusted-publisher workflow (`.github/workflows/publish-python.yml`).

### Changed

- **Breaking:** `init()` now returns a `ScopeCallSDK` instance instead
  of mutating module-level globals. `scopecall.trace(...)` is no longer
  a module-level function; call `sdk.trace(...)` on the returned
  instance.
- **Breaking:** `endpoint` is REQUIRED when `api_key` is set. The
  previous default (`https://ingest.scopecall.com/v1/ingest`) pointed
  at a hosted-Cloud URL that isn't live yet. ConfigError raised
  immediately with a helpful message naming the fix.
- **Breaking:** `sdk.trace(name, ...)` — `name` is now a positional
  required argument; the previous `feature=` kwarg is replaced.
- **Breaking:** `LLMEvent` gained the parity field set: `kind`,
  `prompt_version`, `input_cost_usd`, `output_cost_usd`,
  `finish_reason`, `cache_read_tokens`, `original_model`,
  `budget_state`, `failure_mode`, `tool_calls`. The Rust ingest
  validates these fields, so v0.1 events with the old shape are now
  rejected.
- **Breaking:** Python 3.10+ required (was 3.9+). Uses PEP 604 union
  syntax (`str | None`) at module scope.
- Package name on PyPI is now `scopecall-py` (was `scopecall-python`).
- `sdk.flush(timeout=5.0)` / `sdk.close(timeout=5.0)` are instance
  methods, not module functions.

### Removed

- `Traceloop` / `OpenLLMetry` dependency. The SDK has zero ML-framework
  dependencies on its core path now.
- `opentelemetry-sdk` dependency (the v0.1 SDK pulled it transitively
  through Traceloop).
- v0.1's `_instrumentor`, `_processor`, `_models`, `_client`, `_tracer`
  modules — replaced by the cleaner instance-based shape in `_sdk.py`,
  `_context.py`, and `wire/_event.py`.

### Migration

```python
# v0.1
import scopecall
scopecall.init(api_key="sc_live_xxx")
with scopecall.trace(feature="chat", user_id="u_1"):
    ...

# v0.2
import scopecall
sdk = scopecall.init(
    api_key="sc_live_xxx",
    endpoint="http://localhost:8080/v1/ingest",   # NEW: required
)
with sdk.trace("chat", user_id="u_1"):           # name positional
    ...
sdk.close()                                       # NEW: graceful shutdown
```

If you were on v0.1.x, `pip install --upgrade scopecall` will pull
v0.2 and the imports above will need updating in one place per app.

---

## [0.1.0] — 2026-05-26

First public release.

### Added

**Infrastructure**
- Self-hosted Docker Compose stack: Rust ingest, Go API, Next.js dashboard, ClickHouse 24.3, Postgres 16, Redpanda 23.3, Redis 7
- ClickHouse schema: `llm_calls` table (ReplacingMergeTree, 90-day TTL), `llm_metrics_hourly` AggregatingMergeTree, materialized view for hourly rollups
- Dead-letter queue in Redpanda for failed ingest events with retry
- `infra/.env.example` with all required and optional environment variables

**Ingest service (Rust)**
- HTTP `/ingest` endpoint — accepts batches of `LLMEvent` JSON, validates, forwards to Redpanda
- `/health` endpoint
- PII redaction via configurable regex patterns (`schemas/redaction/patterns.yaml`)
- Distroless container image (no shell attack surface)

**Processor service (Rust)**
- Kafka consumer: `llm_events` topic → ClickHouse `llm_calls` insert
- Enrichment pipeline: provider detection, cost calculation from `schemas/pricing/pricing.json`
- Extended wire format fields: `finish_reason`, `cache_read_tokens`, `original_model`, `budget_state`, `failure_mode`, `tool_calls`

**API service (Go)**
- REST API: `/api/v1/traces`, `/api/v1/cost-summary`, `/api/v1/metrics`
- WebSocket for real-time trace feed
- Postgres-backed org/project/API key management
- ClickHouse query layer for traces and cost aggregation
- `/health` endpoint with dependency status (ClickHouse, Postgres, Redis)

**Dashboard (Next.js)**
- Email + password auth via Auth.js
- First-run setup wizard (`/setup`)
- Real-time traces view
- Cost display by model and feature

**TypeScript SDK (`@scopecall/scopecall-js` v0.1.0)**
- `ScopeCall.init({ apiKey, baseUrl })` — one-line initialization
- `ScopeCall.wrapOpenAI(client)` — wraps the OpenAI client, traces all `chat.completions.create` calls automatically
- Captures: model, provider, input/output tokens, cost, latency, TTFT, finish reason, cache read tokens
- Batched HTTP delivery to ingest service
- Full TypeScript types for `LLMEvent` wire format

### Fixed

- ClickHouse TTL syntax: `TTL toDateTime(timestamp) + INTERVAL 90 DAY` (DateTime64 requires explicit cast)
- ClickHouse default user network restriction: `allow_default.xml` allows Docker-internal connections
- Ingest healthcheck updated to use busybox path (`/busybox/wget`) in distroless image
- Go API Redis URL format: `host:port` (not `redis://` scheme)

### Removed

- `agent_traces` table — agent-level tracing will be implemented later as a materialized view over `llm_calls` (parent_span_id chains), not a separate write target

---

## [0.0.1] — internal

Internal scaffolding and smoke test. Not publicly released.

---

[Unreleased]: https://github.com/scopecall/scopecall/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/scopecall/scopecall/releases/tag/v0.1.0
