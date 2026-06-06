# Roadmap

This is a directional roadmap, not a commitment. Priorities shift based on user feedback. Want to influence what we build next? Open a [GitHub Discussion](https://github.com/scopecall/scopecall/discussions).

## Shipped — v0.3.0

The cost-attribution release. Builds on v0.1.1 (SDK + traces + cost
display) by adding the workflow → agent → step hierarchy, B2B
customer attribution, retry attribution, and a dashboard that turns
the new data into actionable spend.

- **Cost-attribution hierarchy** — `sdk.workflow(name)` /
  `sdk.agent(name)` / `sdk.step(name)` context managers in both
  Python and TypeScript SDKs. Three new container span kinds
  (`workflow` / `agent` / `step`) on the wire; nesting is voluntary,
  not enforced.
- **`customer_id` B2B tenant tag** on `trace()` / `workflow()` /
  `agent()` / `step()` / `record_llm_call()`. Inherited from parent
  spans like `user_id` / `session_id`.
- **Retry attribution** — `attempt_number` + `retry_reason` kwargs
  (closed enum) on `record_llm_call()`. Surfaces in the Waste Inbox.
- **`is_test` traffic flag** via `ScopeCallConfig.test = true` or the
  `SCOPECALL_TEST=1` env var. Excludes eval / CI / replay from cost
  reports.
- **Server-derived cost metadata** — `cost_source` (`server_computed`
  / `sdk_fallback` / `unknown_model` / `container`) and
  `pricing_version` (the `_meta.last_verified` date from
  `schemas/pricing/pricing.json`) on every row.
- **Workflow Treemap** on Overview — tile area = cost, color = delta
  vs prior period, click to drill into a workflow detail page.
- **Workflow detail page** (`/dashboard/workflows/[name]`) — agent /
  step / customer / model breakdowns + retry-cost and test-traffic
  callouts.
- **Customers page** (`/dashboard/customers`) — per-customer rollup
  ranked by cost, with attribution-coverage and retry-offender
  banners.
- **Waste Inbox** on Overview — deterministic-rule findings ranked
  by dollar impact (retry burners, model misuse, high-error
  workflows).
- **Cost Confidence** card on Overview — `cost_source` stacked bar
  + unknown-model punch list pointing at
  `schemas/pricing/pricing.json`.

## Shipped — v0.1.1 / scopecall-py v0.2.0

- **TypeScript SDK** (`@scopecall/scopecall-js@0.1.1`): OpenAI (`chat.completions.create`), Anthropic (`messages.create`), and Vercel AI SDK (`generateText` / `streamText` / `generateObject` / `streamObject`) — streaming + non-streaming for all of them
- **Python SDK** (`scopecall-py@0.2.0`): OpenAI + Anthropic, sync + async, streaming + non-streaming, manual `record_llm_call(...)` for LangChain / LlamaIndex / custom wrappers, `contextvars`-based trace propagation, PII redaction (auto + manual paths), FastAPI example. Wire format and ergonomics match the TS SDK.
- **Workflow spans**: `sdk.trace("...")` blocks surface as their own nodes in the trace tree and Flow Map
- **Prompt version tagging** with the per-version Prompts page
- **Self-hosted Docker Compose stack** (Rust ingest, Go API, Next.js dashboard, ClickHouse, Postgres, Redpanda, Redis)
- **Real-time traces view**, cost / latency / errors dashboards, Flow Map, Sessions, Compare
- **Email + password auth** (Auth.js), API keys with revoke + last-used tracking, saved views, alerts (Slack)
- **Durable processor offsets** + idempotent ClickHouse migration runner so upgrades don't lose data
- **Manual rollup repair script** (`scripts/backfill-llm-metrics-hourly.sh`) for upgrade installs whose pre-005 materialized view polluted historical hours — atomic-rename swap with built-in MV verification

## Next — v0.3.1

- Two-way API key scopes in the dashboard UI — let operators mint
  read-only keys (`traces:read` without `ingest:write`) for export
  scripts and CI jobs. The backend already accepts this combination
  today; v0.3.1 adds the second checkbox + the "at least one scope
  required" form-state guard so it's reachable without dropping to
  curl. (See `ARCHITECTURE.md § Scope vocabulary` for the asymmetry
  this closes.)
- Google Gemini SDK support (TypeScript).
- Productized rollup backfill UX for upgrade installs (kind-aware
  aggregates) — the manual repair script
  `scripts/backfill-llm-metrics-hourly.sh` already ships today;
  v0.3.1 wraps it in a one-click dashboard action with progress +
  dry-run.

## Then — v0.4.x

- OpenTelemetry GenAI bridge (so any OTel-instrumented runtime lights up the dashboard)
- LiteLLM bridge (one integration covers the long-tail provider list)
- Configurable alert channels beyond Slack (webhooks, email)
- Cache hit ratio insights
- Workflow budget alerts on top of the v0.3 cost-attribution data

## v0.5.0 — Framework bridges

- LangChain native callback handler (Python + TypeScript) — closer integration than the current manual API
- LlamaIndex native integration (Python)
- CrewAI / AutoGen / DSPy reach via the OpenTelemetry GenAI bridge

Each framework has its own callback/middleware story, which is why
native bridges land here rather than alongside the v0.3 capture path
— `sdk.record_llm_call(...)` already works today as a manual bridge.

## Later (no committed date)

- Cost intelligence: forecasting, anomaly detection, model right-sizing recommendations
- Budget enforcement: hard caps, smart model fallback, pre-flight cost checks
- Agent debugging: failure mode classification, tool call inspection
- Multi-agent observability: handoff inspection, coherence detection
- Plan-vs-execution divergence analysis
- Evaluation flywheel: trace labeling, LLM-as-judge, few-shot retrieval
- Community plugin SDK for custom instrumentation

## Cloud

A managed ScopeCall Cloud (same software, hosted by us) is planned alongside the self-hosted option. The self-hosted version is open-source under [Apache 2.0](../LICENSE) and is and remains a first-class target — not a stripped-down teaser. Cloud monetization comes from operational excellence + enterprise features (SSO, audit logs, SLA), not licensing teeth.
