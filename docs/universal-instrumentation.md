# Universal Instrumentation — making ScopeCall framework-agnostic

> Status: in progress. Phase 1 (LangGraph auto-agents) shipped in the
> Python SDK; LangChain / CrewAI adapters and the dashboard orchestration
> view are next. This doc is the design north-star.

## Goal

ScopeCall should attach to **any** agent codebase — LangGraph, LangChain,
LlamaIndex, CrewAI, AutoGen, DSPy, or a bespoke loop — and surface the
**complete orchestration** (workflow → agent → step → llm) with
**flow-level cost attribution**, ideally without hand-instrumenting every
node.

## The core principle

ScopeCall can only render what the SDK emits. The dashboard cannot invent
an agent hierarchy it never received. So "show me the agents automatically"
is an **SDK ingestion-logic** problem, not a UI problem: something must
turn each framework's unit of work into a ScopeCall span.

The architecture is therefore a **thin, framework-agnostic core** + **one
small adapter per framework**:

```
                      ┌─────────────────────────────────────────┐
                      │  Core span model (already in the SDK)     │
                      │  workflow / agent / step / llm spans      │
                      │  + thread-safe context (parent_context)   │
                      │  + server-authoritative pricing            │
                      └─────────────────────────────────────────┘
                              ▲          ▲          ▲
              ┌───────────────┘          │          └───────────────┐
        LangGraph adapter          LangChain adapter          CrewAI adapter
     (wrap node → agent)        (callback handler → spans)  (wrap task → agent)
              │                          │                          │
        your graph                 your chains                 your crew
```

Every adapter upholds the same contract:
- **No-op** when ScopeCall is uninitialized (`scopecall.get_active()` is None).
- **Never raises** into the host framework.
- **Idempotent** — instrumenting twice is safe.
- **Thread-safe** — fan-out across `ThreadPoolExecutor` still attributes
  correctly (adapters capture the parent on the originating thread and pass
  it via `parent_context` / `capture_context()`).

## Core primitives (shipped)

- `sdk.workflow() / agent() / step()` — the span hierarchy. Each now accepts
  `parent_context=` so a span can be created as a child of an explicit
  context across thread boundaries.
- `sdk.capture_context()` — grab the active span as a portable handle to
  hand to worker threads.
- `sdk.record_llm_call(..., context=)` — emit an LLM call attributed to an
  explicit parent (the thread-safe escape hatch).
- `scopecall.get_active()` — discover the SDK instance so adapters need no
  wiring.
- `scopecall.integrations._base.span_callable()` / `traced_agent()` — wrap
  any callable as a span; the shared building block for every adapter.

## Adapters

### LangGraph (shipped — Phase 1)

```python
import scopecall
from scopecall.integrations import langgraph as sc_langgraph

scopecall.init(api_key=..., endpoint=...)
sc_langgraph.instrument()          # once, before building graphs

# build StateGraph as usual — every node becomes an `agent` span
```

`instrument()` monkey-patches `StateGraph.add_node` so each node callable is
wrapped in an agent span, lazily resolving the SDK at node-run time (so init
ordering is irrelevant). Explicit alternative: `agent_node(name, fn)`.

### LangChain (planned)

A `ScopeCallCallbackHandler` mapping callback events to spans:
`on_chain_start` → agent/step, `on_tool_start` → step, `on_llm_start/end` →
llm (with token usage). Pass it via `config={"callbacks": [handler]}` — no
code edits to chains.

### CrewAI / AutoGen / DSPy (planned)

Wrap the framework's agent/task execution entry points with
`span_callable(..., kind="agent")`. Same core, different attach point.

### Generic / bespoke loops

`from scopecall.integrations._base import traced_agent` →
`@traced_agent("router")` on any function. Always available.

### OpenTelemetry GenAI bridge (planned — the universal path)

Accept OTLP spans following the GenAI semantic conventions at the ingest
service, so anything already emitting OTel traces (via OpenLLMetry /
OpenInference auto-instrumentors for 20+ frameworks) flows in with no
ScopeCall-specific code at all. This is the long-term "works with anything"
answer; the native adapters above are the high-fidelity fast path.

## Flow-level pricing

Cost attribution rolls up the span tree: every `llm` span carries
server-recomputed cost (`cost_source` + `pricing_version`); container spans
(workflow/agent/step) are zeroed and accumulate their descendants' cost on
the dashboard. With the adapters above, that means **cost per node, per
step, per model, per customer** — for any framework — without bespoke
plumbing. Keep `schemas/pricing/pricing.json` current (incl. fine-tuned and
newest model ids) so `cost_source` reads `server_computed` rather than
`sdk_fallback`.

## Dashboard (planned — orchestration view)

With agent/step spans flowing, the trace tree and workflow-detail
breakdowns populate. The planned enhancement is a dedicated **orchestration
panel**: the workflow → agent → step → llm tree as a first-class view, with
cost/latency/error/retry rolled up at each level and the parallel fan-out
(e.g. OpenAI + Gemini consensus) rendered side-by-side.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Thread-safe `parent_context`; `get_active()`; framework-agnostic core; **LangGraph auto-agents** | ✅ shipped (Python) |
| 2 | Per-step spans inside threaded fan-out (consensus chunks) | ✅ shipped (Python) |
| 3 | LangChain callback adapter (`ScopeCallCallbackHandler`) | ✅ shipped (Python) |
| 4 | CrewAI adapter (`instrument()`); `start_span`/`end_span` lifecycle primitives | ✅ shipped (Python) |
| 5 | Dashboard orchestration view (`OrchestrationTree` on the trace drawer) | ✅ shipped (Next build green) |
| 6 | OpenTelemetry GenAI ingest bridge (`POST /v1/traces`, OTLP/JSON → LlmEvent) | ✅ shipped (Rust image build green; unit tests written) |
| — | TypeScript SDK parity: core (`getActive`/`captureContext`/`parentContext`) + manual span/record API (`startSpan`/`endSpan`/`recordLlmCall`) + LangChain adapter | ✅ shipped (build + 123 tests green) |

Python coverage: 87 tests passing (incl. `tests/test_integrations.py` covering the
core, LangGraph, LangChain, CrewAI, and the span lifecycle).
