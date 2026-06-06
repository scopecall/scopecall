# ScopeCall — Architecture

Source-available, self-hostable AI observability. Capture every LLM call,
track costs, trace what went wrong — without routing traffic through a
proxy.

> **Looking for the long-form architecture writeup?** A larger draft from
> the v0.1 development cycle is preserved at
> [`docs/archive/ARCHITECTURE-v0.1-draft.md`](docs/archive/ARCHITECTURE-v0.1-draft.md).
> It is not authoritative — parts of its integration matrix (Python SDK,
> framework bridges) describe v0.3 roadmap items. The shipped surface is
> what's documented here.

---

## Data flow

```
Your app (SDK)
   │  HTTP batch (every 5 s, or sdk.flush() / sdk.close())
   ▼
Rust ingest service (:8080)          ← validates payload, resolves API key,
   │                                   publishes to Kafka. No state of its own.
   ▼
Redpanda topic: events.llm_calls     ← durable buffer between ingest and processor.
   │
   ▼
Rust processor                       ← consumes events, enriches with
   │                                   server-authoritative pricing, writes
   │                                   to ClickHouse. Owns the durable Kafka
   │                                   offset and the DLQ on retry exhaustion.
   ▼
ClickHouse                           ← `llm_calls` (source of truth) +
                                       `llm_metrics_hourly` (MV-driven rollup,
                                       `kind='llm'` only).

Go API (:8081)                       ← READ-ONLY against ClickHouse + Postgres.
   ├── reads ClickHouse              ← traces, cost, prompts, sessions, flow map,
   │                                   regressions, top movers, breakdown.
   └── reads / writes Postgres       ← orgs, users, api_keys, saved views,
                                       alert rules + events.

Next.js dashboard (:3000)            ← Auth.js sessions; reverse-proxies the
                                       browser to the Go API via the
                                       `INTERNAL_API_KEY` trusted header path.
```

**Hot path is SDK → Rust ingest → Redpanda → Rust processor → ClickHouse.**
The Go API never consumes from Redpanda. The dashboard never talks to
ClickHouse or Redpanda directly — every read goes through the Go API.

---

## Surfaces shipped in v0.3.0

| Surface | Status |
|---|---|
| TypeScript SDK — OpenAI `chat.completions.create` (streaming + non-streaming) | ✅ |
| TypeScript SDK — Anthropic `messages.create` (streaming + non-streaming) | ✅ |
| TypeScript SDK — Vercel AI SDK (`generateText` / `streamText` / `generateObject` / `streamObject`) | ✅ |
| Python SDK at TypeScript parity (`scopecall-py`) | ✅ |
| `sdk.workflow()` / `sdk.agent()` / `sdk.step()` cost-attribution hierarchy (Python + TS) | ✅ |
| Persisted container spans — `workflow` / `agent` / `step` rows with zeroed cost (`kind`-aware analytics) | ✅ |
| `customer_id` B2B tenant attribution + retry attribution (`attempt_number`, `retry_reason`) + `is_test` traffic flag | ✅ |
| Server-derived cost metadata (`cost_source`, `pricing_version`) — every row carries a trust signal | ✅ |
| Dashboard: Workflow Treemap, workflow detail, Customers page, Waste Inbox, Cost Confidence card | ✅ |
| Prompt version tagging — surfaces in the Prompts page | ✅ |
| Server-authoritative pricing — processor recomputes cost from bundled pricing table | ✅ |
| Self-hosted Docker Compose stack (Rust ingest, Rust processor, Go API, Next.js dashboard, ClickHouse, Postgres, Redpanda, Redis) | ✅ |
| Auth.js email + password auth | ✅ |
| API key management — Settings → API Keys (generate, list, revoke, scopes, 30-day audit retention) | ✅ |
| Alerts — cost-spike / error-rate / p99-latency rules, Slack channel | ✅ |
| Idempotent ClickHouse migration runner with applied-migration tracker | ✅ |
| Durable processor Kafka offset across restarts | ✅ |
| Manual rollup backfill script for upgrade installs ([`scripts/backfill-llm-metrics-hourly.sh`](scripts/backfill-llm-metrics-hourly.sh)) | ✅ |
| Gemini SDK support | 🔜 v0.3.1 |
| Productized rollup backfill UX (one-click from the dashboard) | 🔜 v0.3.1 |
| OpenTelemetry GenAI bridge | 🔜 v0.4.x |
| LiteLLM bridge | 🔜 v0.4.x |
| Native LangChain / LlamaIndex framework bridges (Python + TS) | 🔜 v0.5.0 |
| Cost intelligence (forecasting, anomaly detection, model right-sizing) | 🔜 |
| Budget enforcement (hard caps, smart model fallback) | 🔜 |
| Agent execution debugger | 🔜 |

The roadmap (`docs/roadmap.md`) is the authoritative source.

---

## Why no proxy

The SDK instruments the OpenAI / Anthropic / Vercel AI SDK clients in
place — wrapping `chat.completions.create`, `messages.create`, and
`doGenerate` / `doStream` respectively. The user's call still hits the
provider's API directly; ScopeCall only observes the inputs and outputs
in the same process.

This matters because:

- **No added latency in the critical path.** The instrumentation is a
  thin Promise.race around the provider call; the trace event is queued
  in a circular buffer and shipped to ingest out-of-band.
- **No vendor-lock to ScopeCall's availability.** A ScopeCall outage
  cannot take down LLM calls — the user's request continues to the
  provider whether or not ingest is reachable.
- **Trace data stays in your infrastructure.** The Rust ingest +
  ClickHouse + processor stack runs entirely on your hardware; no third
  party sees prompts, completions, or cost data.

The trade-off: a proxy can do gateway-style routing (model fallback,
provider failover, key pooling). ScopeCall doesn't try to be that. We
observe and explain spend, latency, and failures — gateway concerns live
in a separate layer.

---

## Storage model

| Table | Engine | What's in it |
|---|---|---|
| `llm_calls` | `ReplacingMergeTree` | Source of truth. One row per LLM call (`kind='llm'`) plus synthetic container rows from `sdk.workflow()` / `sdk.agent()` / `sdk.step()` blocks (`kind='workflow' \| 'agent' \| 'step'`). Container rows carry zero cost — the processor's `reprice()` zeros them so SDK-supplied numbers on container kinds can't poison aggregates. Replacing key is `(org_id, timestamp, span_id)` so at-least-once delivery dedupes at merge time. v0.3 columns: `customer_id`, `attempt_number`, `retry_reason`, `is_test`, `cache_read_cost_usd`, `cost_source`, `pricing_version`. |
| `llm_metrics_hourly` | `AggregatingMergeTree` | Pre-aggregated hourly rollup, populated by the `llm_calls_to_metrics_mv` materialized view. Filtered to `kind='llm'` so container rows don't pollute call counts / latency / cost aggregates. |
| `_scopecall_migrations` | `ReplacingMergeTree` | Self-tracking applied-migration list. Lets the migration runner skip already-applied SQL on every compose restart. |

Postgres holds the small, write-shaped state: `orgs`, `users` (Auth.js),
`api_keys`, `saved_views`, `alert_rules`, `alert_events`. The Go API is
the only writer; the Rust ingest and processor read api_keys for auth.

---

## Security boundaries

- The Rust ingest service authenticates SDK requests with API keys
  (`sc_live_*`). Keys have scopes; `ingest:write` is required for the
  ingest path.
- The Go API authenticates via two paths: trusted-proxy (the Next.js
  dashboard with the `INTERNAL_API_KEY` header + identity headers
  derived from the verified Auth.js JWT) or bearer API key. Bearer keys
  must have the `traces:read` scope to reach the dashboard read API.
- Cache namespaces are split between services: `key:ingest:<hash>` for
  the Rust ingest positive cache, `key:read:<hash>` for the Go API
  positive cache, `revoked:<hash>` shared as a 5-minute negative-cache
  marker so revoke takes effect immediately on both paths.
- Write endpoints that produce user-attributed resources (saved views
  carry `created_by`) require a real user session — the handler
  rejects auth shapes with an empty `UserID`, which is the property
  that distinguishes API-key bearer auth from dashboard-session or JWT
  auth. API keys are a service identity, not a user identity.

### Scope vocabulary, v0.1.1

The wire protocol accepts any combination of `ingest:write` and
`traces:read`. The Rust ingest service enforces `ingest:write`
independently of the Go API's `traces:read` enforcement, so a key
minted with one scope but not the other is accepted exactly where it
should be and rejected elsewhere.

The dashboard's create-key form in v0.1.1 surfaces only the read
opt-in: every minted key includes `ingest:write` as a baseline, and
the user opts into `traces:read` separately. This is a UI shortcut for
the 95% case (SDK keys shipped from a customer's backend) — it does
NOT mean read-only keys are impossible. An operator who wants a
read-only key (for a metrics-export script or CI job) can mint one
directly against the API with `{"scopes": ["traces:read"]}`; the Rust
ingest service will correctly reject any write attempt from that key.

**v0.1.2** brings the two-checkbox UI so a read-only key can be
minted from the dashboard without dropping to curl. Until then, the
asymmetry to be aware of: a leaked dashboard-minted key always at
least has `ingest:write`, so the asymmetric protection `traces:read`
buys is in the read direction only.

For the full threat model + the deferred hosted-SaaS hardening list, see
`SECURITY.md`.
