# Changelog

All notable changes to ScopeCall are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## ScopeCall — [0.3.2] — 2026-06-10

Patch release. Self-hosting and documentation fixes; no API, SDK, or
schema changes. Drop-in for existing installs.

### Fixed

- **Self-hosting:** ClickHouse schema is now managed solely by the
  migration runner. Removed redundant init-time schema mounts from
  `infra/docker-compose.yml` that could double-apply migrations on a
  fresh volume or be silently skipped on an upgrade.
- **Docs:** Corrected `SCOPECALL_VERSION` examples in `infra/.env.example`
  and the self-hosting guide to use the unprefixed image tag (e.g.
  `0.3.2`, not `v0.3.2`). Published image tags never carry a leading `v`.

### Changed

- **Go API:** API-key creation failures now log the underlying database
  error server-side to aid operator debugging. The HTTP response is
  unchanged — still a generic 500 with no driver or constraint detail
  leaked over the wire.

### Upgrade

Set `SCOPECALL_VERSION=0.3.2` in `infra/.env`, then:

```bash
docker compose -f infra/docker-compose.yml pull
docker compose -f infra/docker-compose.yml up -d
```

---

## ScopeCall — [0.3.1] — 2026-06-09

A full dashboard redesign on top of the 0.3.0 cost-attribution core.
No SDK or API changes — drop-in for existing installs.

### Changed

- **Rebuilt dashboard.** The redesigned surface is now the canonical
  `/dashboard/*` experience; the legacy UI is retired. New navigation
  chrome with an account menu + theme switcher, a refreshed dark theme,
  and a light theme with legible semantic colors.
- **Consistent affordances.** Shared hover / active / focus states and a
  real elevation scale, so every clickable surface reads as clickable.
- **Processor throughput.** Events are borrowed into ClickHouse rows
  instead of cloning the batch on every flush.

### Fixed

- **Rollup correctness.** Fixes an `llm_metrics_hourly` undercount
  (additive columns are now summed correctly) plus a reconcile-from-raw
  safety net.

---

## ScopeCall — [0.3.0] — 2026-06-06

The cost-attribution release. Expand the wire format, ingest,
processor, ClickHouse storage, Go API, and dashboard so users can
answer "which workflow / agent / customer / retry was that dollar?"
without proxying provider traffic.

### Added — SDK (Python + TypeScript)

- `sdk.workflow(name, ...)` / `sdk.agent(name, ...)` /
  `sdk.step(name, ...)` — three nested context managers that emit
  distinct container span kinds (`workflow` / `agent` / `step`) on
  the synthetic span. Thin shims over `sdk.trace()`; nesting is
  voluntary, not enforced.
- `customer_id` kwarg on `trace()` / `workflow()` / `agent()` /
  `step()` / `record_llm_call()`. Inherited from parent spans like
  `user_id` / `session_id`. PII contract documented on the wire
  types: must be a tenant / account slug or opaque ID, never raw
  email / name / PII.
- `attempt_number` + `retry_reason` kwargs on `record_llm_call()`.
  `retry_reason` is a closed enum enforced at ingest:
  `rate_limit | timeout | server_error | transient_network |
  agent_decision | manual | unknown`.
- `ScopeCallConfig.test = true` (or `SCOPECALL_TEST=1` env var) — tags
  every event with `is_test=true` so non-production traffic (eval, CI,
  replays) can be excluded from cost reports.

### Added — wire format and ingest

Eight new optional fields on `LLMEvent`: `customer_id`,
`attempt_number`, `retry_reason`, `is_test`, `cache_read_cost_usd`,
`cost_source`, `pricing_version`, plus expansion of the `kind` enum
to include `agent` and `step`. Backward-compatible with v0.1 SDKs
via serde defaults — missing fields take sensible zeros.

### Added — processor

- Server-derived `cost_source` (`server_computed` | `sdk_fallback` |
  `unknown_model` | `container`) and `pricing_version` (the
  YYYY-MM-DD `_meta.last_verified` from `schemas/pricing/pricing.json`).
  Container spans (workflow / agent / step) are zeroed by `reprice()`
  so SDK-supplied cost on container kinds can't poison analytics.
- `cache_read_cost_usd` derived per-model when the pricing table
  carries a cache_read rate.

### Added — storage

- ClickHouse migrations `006_customer_id.sql` /
  `007_retry_and_test_flag.sql` / `008_cost_metadata.sql` splice the
  new columns into `llm_calls`. All idempotent via the migration
  runner's applied-migration tracker.

### Added — Go API

Five new hand-wired endpoints, all scoped by JWT `claims.OrgID` and
cached through the Redis cache middleware:

- `GET /api/v1/workflow-cost-tree` — workflow rollup + prior-period
  delta for the Overview treemap.
- `GET /api/v1/workflow-detail` — one-shot summary + agent / step /
  customer / model / cost_source breakdowns for the workflow detail
  page. Agent + step attribution via 2-hop `parent_span_id` join.
- `GET /api/v1/customer-profitability` — per-customer rollup + a
  separate totals query so the "Unattributed" tile is computed
  against the grand total (not the truncated LIMIT'd row sum).
- `GET /api/v1/waste-inbox` — deterministic-rule scan (retry
  burners, model misuse, high-error workflows) ranked by potential
  savings descending.
- `GET /api/v1/cost-confidence` — `cost_source` shares + punch list
  of unknown models pointing at `schemas/pricing/pricing.json`.

Plus a `customer_id` filter on `GET /api/v1/traces` (mirroring the
existing `user_id` / `feature_name` / `prompt_version` pattern).

### Added — dashboard

- **Overview**: Workflow Treemap (hand-rolled SVG, tile area =
  current cost, color = delta vs prior period), Waste Inbox card
  (deterministic findings with $-impact + drill-in), Cost Confidence
  card (stacked bar + unknown-model punch list).
- **Workflow detail page** (`/dashboard/workflows/[name]`) — agent /
  step / customer / model breakdowns, retry-cost and test-traffic
  callouts, embedded cost-source strip.
- **Customers page** (`/dashboard/customers`) — ranked per-customer
  rollup with attribution-coverage banner (< 50% triggers an SDK-
  wiring nudge) and a retry-offender banner.
- **Traces**: `customer_id` filter chip (chip-only pattern — no
  dropdown, since customer cardinality scales with tenant count).

### Notes

- LIMIT values on the new endpoints are passed as parameterized CH
  query parameters (`{lim:UInt32}`) rather than spliced via
  `fmt.Sprintf`. Handlers clamp limits upstream; parameter binding
  keeps the SQL safe under future refactors.
- The Waste Inbox total-savings figure is labeled "up to $X" — a
  workflow that appears under multiple rules (e.g. retry + error)
  can be counted under each, so the headline is an upper bound by
  design.

---

## Python SDK — [0.3.0] — 2026-06-06

Cost-attribution release for `scopecall-py`. Adds the workflow → agent
→ step hierarchy, B2B customer attribution, retry attribution, and a
test-traffic flag. Wire-compatible with the platform `v0.3.0` release.

### Added

- `sdk.workflow(name, ...)` / `sdk.agent(name, ...)` /
  `sdk.step(name, ...)` — three nested context managers over
  `sdk.trace()` that emit distinct container span kinds on the
  synthetic span (`kind='workflow'` / `'agent'` / `'step'`
  respectively). Nesting is voluntary, not enforced; the dashboard
  rolls up cost from LLM calls to whichever ancestor you wrap.
- `customer_id` kwarg on `trace()` / `workflow()` / `agent()` /
  `step()` / `record_llm_call()` — B2B tenant attribution distinct
  from `user_id`. Inherited from parent spans like `user_id` /
  `session_id`. PII contract: must be a tenant / account slug or
  opaque ID, never raw email / name / PII.
- `attempt_number` + `retry_reason` kwargs on
  `record_llm_call()`. `retry_reason` is a closed enum enforced at
  ingest: `rate_limit | timeout | server_error |
  transient_network | agent_decision | manual | unknown`.
- `ScopeCallConfig.test = True` (or `SCOPECALL_TEST=1` env var) —
  tags every event with `is_test=true` so non-production traffic
  (eval, CI, replays) can be excluded from production cost
  reports.
- `SpanKind` Literal type re-exported from `scopecall._context`
  for callers that want narrowed type checking on the `kind`
  parameter.

### Changed

- `TraceContext.kind` and the `kind` parameters on `sdk.trace()` /
  `sdk.span()` are now typed as `Literal["llm", "workflow",
  "agent", "step"]` (was `str`). Mirrors the wire `LLMEvent.kind`'s
  existing Literal type and matches the Rust ingest's closed-enum
  validation.

### Notes

- README updated with a new "Cost attribution hierarchy" section
  showing the nested workflow / agent / step pattern. The
  quickstart example now uses `sdk.workflow(name, customer_id=...)`
  in place of `sdk.trace(name, ...)`. `sdk.trace()` remains
  supported as a backward-compatible alias.
- FastAPI example (`sdks/python/examples/fastapi/app.py`) updated
  to use `sdk.workflow()` and to thread `customer_id` from the
  request model.

---

## TypeScript SDK — [0.3.0] — 2026-06-06

Cost-attribution release for `@scopecall/scopecall-js`. Mirrors the
Python SDK 0.3.0 surface so both SDKs ship the same v0.3 cost-
attribution capabilities. Wire-compatible with the platform `v0.3.0`
release.

Version jumps 0.1.x → 0.3.0 to align with the platform tag — same
underlying APIs as Python SDK 0.3.0.

### Added

- `sdk.workflow(name, fn, opts?)` / `sdk.agent(name, fn, opts?)` /
  `sdk.step(name, fn, opts?)` — three nested async-callback helpers
  over `sdk.trace()` that emit distinct container span kinds
  (`workflow` / `agent` / `step`). Nesting is voluntary; the
  dashboard rolls up cost from LLM calls to whichever ancestor you
  wrap.
- `customerId` on `TraceOptions` — B2B tenant attribution distinct
  from `userId`. Inherited from parent traces. PII contract: must be
  a tenant / account slug or opaque ID, never raw email / name /
  PII.
- `test: boolean` on `ScopeCallConfig` (or `SCOPECALL_TEST=1` env
  var) — tags every event with `is_test=true` so non-production
  traffic (vitest / jest runs, eval suites, replays) stays out of
  production cost reports.
- README "Cost attribution hierarchy" section with worked examples
  of the nested workflow / agent / step pattern. Quickstart and
  optional-metadata examples updated to use `sdk.workflow()` in
  place of bare `sdk.trace()`.

### Notes

- `sdk.trace(name, fn, opts?)` remains supported as a backward-
  compatible alias for `sdk.workflow()` — every example in the
  README that uses `sdk.trace(...)` continues to work.
- Providers table corrected: Gemini → v0.3.1, native LangChain /
  LlamaIndex bridges → v0.5.0, OpenTelemetry-bridged frameworks
  (CrewAI / AutoGen / DSPy) → v0.4.x. OpenAI, Anthropic, and
  Vercel AI SDK instrumentation continue to work in 0.3.0.

---

## TypeScript SDK — [0.1.2] — 2026-06-04

### Changed

- License: Apache 2.0. Package metadata updated. No code, behavior, or
  wire-format changes from `0.1.1`.

---

## Python SDK — [0.2.1] — 2026-06-04

### Changed

- License: Apache 2.0. Package metadata updated. No code, behavior, or
  wire-format changes from `0.2.0`.

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
  `kind='workflow'` event on exit, matching the TS SDK contract.
  Children inside the block reference the workflow's `span_id` as
  their `parent_span_id`.
- `sdk.workflow(name)` alias of `sdk.trace(name)`.
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
