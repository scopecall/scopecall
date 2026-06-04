# Roadmap

This is a directional roadmap, not a commitment. Priorities shift based on user feedback. Want to influence what we build next? Open a [GitHub Discussion](https://github.com/scopecall/scopecall/discussions).

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

## Next — v0.1.2

- Two-way API key scopes in the dashboard UI — let operators mint
  read-only keys (`traces:read` without `ingest:write`) for export
  scripts and CI jobs. The backend already accepts this combination
  today; v0.1.2 adds the second checkbox + the "at least one scope
  required" form-state guard so it's reachable without dropping to
  curl. (See `ARCHITECTURE.md § Scope vocabulary` for the v0.1.1
  asymmetry this closes.)
- Google Gemini SDK support (TypeScript).
- Productized rollup backfill UX for upgrade installs (kind-aware
  aggregates) — the manual repair script
  `scripts/backfill-llm-metrics-hourly.sh` already ships in v0.1.1;
  v0.1.2 wraps it in a one-click dashboard action with progress + dry-run.

## Then — v0.2.x

- LangChain framework integration
- OpenTelemetry GenAI bridge (so any OTel-instrumented runtime lights up the dashboard)
- LiteLLM bridge (one integration covers the long-tail provider list)
- Configurable alert channels beyond Slack (webhooks, email)
- Cache hit ratio insights

## v0.3.0 — Framework bridges

- LangChain native callback handler (Python + TypeScript) — closer integration than the current manual API
- LlamaIndex native integration (Python)
- CrewAI / AutoGen / DSPy reach via the OpenTelemetry GenAI bridge

Python parity itself moved up to v0.1.1 (above) — the Python SDK
shipped as `scopecall-py@0.2.0` with OpenAI + Anthropic instrumentation
matching the TS surface. Native framework integrations remain v0.3
work because each framework has its own callback/middleware story.

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
