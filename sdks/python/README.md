# scopecall

Python SDK for [ScopeCall](https://scopecall.com) — source-available, self-hostable AI cost and workflow observability.

[![PyPI](https://img.shields.io/pypi/v/scopecall-py)](https://pypi.org/project/scopecall-py/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Python](https://img.shields.io/pypi/pyversions/scopecall-py)](https://pypi.org/project/scopecall-py/)

Wraps the OpenAI and Anthropic Python clients so every LLM call shows
up in your ScopeCall dashboard with cost, latency, prompt-version, and
workflow-tree attribution — **without** routing traffic through a
proxy.

---

## Install

```bash
pip install scopecall-py

# Or with provider extras (recommended — pins to a known-good lower bound):
pip install "scopecall-py[openai]"
pip install "scopecall-py[anthropic]"
pip install "scopecall-py[all]"
```

The PyPI package is named `scopecall-py` (Supabase-style language
suffix); the Python import name stays just `scopecall`. So you `pip
install scopecall-py` and then `from scopecall import init`.

Python 3.10+ required.

---

## Quick start

```python
import scopecall
from openai import OpenAI

# Initialize once at app startup.
sdk = scopecall.init(
    api_key="sc_live_xxx",                       # from your ScopeCall dashboard
    endpoint="http://localhost:8080/v1/ingest",  # required: self-hosted ingest URL
)

# Wrap the OpenAI client — every chat.completions.create call is now traced.
openai_client = sdk.instrument(OpenAI())

with sdk.trace("support-agent", user_id="user_123") as ctx:
    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Hello"}],
    )

# Traces appear in your dashboard within seconds.
```

> **No hosted-Cloud default yet.** A managed default endpoint will
> return when ScopeCall Cloud is live. Until then, `init()` requires
> `endpoint` to be set explicitly when using `api_key` — fail-fast is
> safer than silently sending events to a domain that doesn't exist.

---

## Configuration

```python
sdk = scopecall.init(
    api_key="sc_live_xxx",                       # required (or use debug=True / output=<path>)
    endpoint="http://localhost:8080/v1/ingest",  # required when using api_key
    environment="production",                    # optional; defaults to "production"
    capture_content=True,                        # optional; record prompts/completions (default True)
    redact_pii=True,                             # optional; PII redaction (default True)
    batch_size=50,                               # optional; events per HTTP batch
    max_retries=3,                               # optional; retry attempts on transient failure
    flush_interval=5.0,                          # optional; seconds between auto-flush
    debug=False,                                 # optional; route events to stdout instead of HTTP
)
```

Other transport modes:

```python
# Console mode — pretty-prints events to stdout. Useful during integration.
sdk = scopecall.init(debug=True)

# File mode — appends NDJSON events to a path. Useful for offline capture.
sdk = scopecall.init(output="/var/log/scopecall.ndjson")

# Disabled mode — no-op SDK that swallows every call. Useful in tests.
sdk = scopecall.init(disabled=True)
```

---

## Anthropic

```python
import scopecall
import anthropic

sdk = scopecall.init(
    api_key="sc_live_xxx",
    endpoint="http://localhost:8080/v1/ingest",
)

anthropic_client = sdk.instrument(anthropic.Anthropic(), provider="anthropic")

msg = anthropic_client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

Streaming works the same way — pass `stream=True` and iterate. TTFT
(time to first token) is captured automatically; output content is
assembled from `content_block_delta` events; final token counts come
from the `message_delta` event Anthropic emits near end-of-stream.

---

## Async

Both `AsyncOpenAI` and `AsyncAnthropic` are first-class — `instrument()`
auto-detects async vs sync from the client and wraps accordingly. No
separate API.

```python
import asyncio
import scopecall
from openai import AsyncOpenAI

sdk = scopecall.init(
    api_key="sc_live_xxx",
    endpoint="http://localhost:8080/v1/ingest",
)
client = sdk.instrument(AsyncOpenAI())

async def main():
    # Use asyncio.gather so this snippet runs on Python 3.10 (the SDK's
    # lower bound). asyncio.TaskGroup is 3.11+; if you're on 3.11 or
    # later it's a cleaner choice for structured concurrency.
    await asyncio.gather(*(
        client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": f"Hello {i}"}],
        )
        for i in range(3)
    ))

asyncio.run(main())
```

`contextvars` propagate the active `sdk.trace()` context across
`await` and `asyncio.create_task()`, so concurrent calls inside the
same trace get the right `parent_span_id` automatically.

---

## Workflow tracing

The `sdk.trace(name)` block emits a synthetic **workflow span** when it
exits, so the ScopeCall dashboard can render the parent → child
structure of multi-call agents:

```python
with sdk.trace("rag-question", user_id=user_id, session_id=session_id):
    # 1) retrieve documents (could itself be an LLM call)
    docs = retriever.retrieve(question)

    # 2) call the LLM with the retrieved context
    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": f"Context:\n{docs}"},
            {"role": "user", "content": question},
        ],
    )
```

In the dashboard's trace tree, that block renders as:

```
rag-question                          (workflow span)
└── chat.completions.create           (LLM span)
```

Nested traces work too — the inner block inherits `trace_id`,
gets its own `span_id`, and sets `parent_span_id` to the outer block.

### Streaming + workflow latency

When a streaming response is iterated AFTER the enclosing
`sdk.trace()` block has exited (the common pattern with FastAPI's
`StreamingResponse`, where the route handler returns and the iterator
runs later), the SDK still attaches the child LLM event to the
workflow span correctly — context is snapshotted when
`.create()` is called, not when the stream is consumed.

But the workflow span's **latency** only covers what's inside the
`with` block. If you want workflow latency to reflect the full
streaming duration, keep the trace block open across the iteration:

```python
async def event_source():
    with sdk.trace("chat-api", user_id=req.user_id):
        stream = await openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            stream=True,
        )
        async for chunk in stream:
            yield chunk

return StreamingResponse(event_source(), media_type="text/event-stream")
```

The runnable FastAPI example below uses exactly this shape.

---

## Per-call metadata

Set defaults SDK-wide on `init()`, then override per-trace:

```python
sdk = scopecall.init(
    api_key="sc_live_xxx",
    endpoint="http://localhost:8080/v1/ingest",
    default_feature="chat",                       # every call tagged "chat"
    default_user_id="anonymous",
    default_prompt_version=os.getenv("DEPLOY_SHA"),  # auto-tag with commit hash
)

# Per-call overrides win over defaults; nested-trace inheritance fills
# the gap for prompt_version (trace > parent > default > None).
with sdk.trace("billing-agent", user_id=user.id, prompt_version="refund-v3"):
    ...
```

---

## Prompt-version tracking

Tag each `sdk.trace()` with a `prompt_version`. The ScopeCall Prompts
page surfaces cost / latency / error-rate **per version** — ship a new
prompt, see whether output tokens went up:

```python
PROMPT_V = "refund-policy-v7"

with sdk.trace("support-agent", prompt_version=PROMPT_V):
    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": PROMPT_V_TEXT},
            {"role": "user", "content": question},
        ],
    )
```

Nested traces inherit the parent's `prompt_version`. To clear it on a
child span, pass `prompt_version=None` explicitly (which doesn't
override; you'd want a different scope name instead).

---

## Manual instrumentation (LangChain, LlamaIndex, custom)

If you're calling an LLM through a framework that wraps the underlying
client (LangChain, LlamaIndex, CrewAI, your own gateway), `instrument()`
can't see through to the raw call. Use `sdk.record_llm_call()` to emit
events manually — same wire format, same trace-context chaining:

```python
with sdk.trace("rag-answer"):
    docs = retriever.retrieve(q)         # your code, not instrumented

    # ... call your custom LLM wrapper ...
    sdk.record_llm_call(
        model="gpt-4o-mini",
        provider="openai",
        input_tokens=1234,
        output_tokens=567,
        latency_ms=842,
        input_text=prompt,
        output_text=answer,
        finish_reason="stop",
    )
```

`record_llm_call` reads the current `sdk.trace()` context to set
`parent_span_id` and inherit feature / user / session / prompt_version.
PII redaction (`redact_pii=True`) applies to manual calls too — input
and output run through the same scrubber the auto-instrumented path
uses.

For deeper sub-step instrumentation (e.g. "retrieve" and "rerank" as
separate visible spans), nest `sdk.trace()` blocks rather than reaching
for a sub-span helper. Each nested `trace` block emits its own
workflow span and chains correctly:

```python
with sdk.trace("rag-answer"):
    with sdk.trace("retrieve"):
        docs = retriever.retrieve(q)
    with sdk.trace("generate"):
        sdk.record_llm_call(...)
```

---

## FastAPI

```python
from contextlib import asynccontextmanager

import scopecall
from fastapi import FastAPI
from openai import AsyncOpenAI

sdk: scopecall.ScopeCallSDK
client: AsyncOpenAI


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize the SDK once at startup; close on shutdown so the
    background flush thread drains pending events before exit."""
    global sdk, client
    sdk = scopecall.init(
        api_key=os.environ["SCOPECALL_API_KEY"],
        endpoint=os.environ.get(
            "SCOPECALL_ENDPOINT", "http://localhost:8080/v1/ingest"
        ),
        environment=os.environ.get("ENV", "production"),
        default_prompt_version=os.environ.get("DEPLOY_SHA"),
    )
    client = sdk.instrument(AsyncOpenAI())
    yield
    sdk.close(timeout=5.0)


app = FastAPI(lifespan=lifespan)


@app.post("/chat")
async def chat(req: ChatRequest):
    with sdk.trace("chat-api", user_id=req.user_id, session_id=req.session_id):
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=req.messages,
        )
        return {"reply": response.choices[0].message.content}
```

A runnable version of this example lives in
[`examples/fastapi/`](examples/fastapi/).

---

## What gets captured

Every traced LLM call captures:

| Field | Description |
|-------|-------------|
| `model` | Canonical model name (e.g. `gpt-4o-mini`, `claude-3-5-sonnet-20241022`) |
| `provider` | `openai` or `anthropic` |
| `input_tokens` | Prompt token count |
| `output_tokens` | Completion token count |
| `cache_read_tokens` | OpenAI prompt cache hits / Anthropic `cache_read_input_tokens` |
| `cost_usd` | Computed server-side from the bundled pricing table |
| `latency_ms` | End-to-end latency |
| `ttft_ms` | Time to first token (streaming only) |
| `finish_reason` | `stop` / `length` / `tool_calls` / `end_turn` (Anthropic) |
| `status` | `success` / `error` / `timeout` / `rate_limited` |
| `error_message` | Error detail on failure |
| `input_text` | Full prompt (redacted per your PII config) |
| `output_text` | Full completion |
| `tool_calls` | Tool-use blocks as JSON (Anthropic) |
| `prompt_version` | Per-trace label from `sdk.trace()` or config — powers the Prompts page |
| `feature_name` / `user_id` / `session_id` | From `sdk.trace()` or `init()` defaults |
| `kind` | `llm` for provider calls; `workflow` / `agent` / `step` for container spans from `sdk.trace()` / `sdk.workflow()` / `sdk.agent()` / `sdk.step()` |
| `customer_id` | B2B tenant identifier. **Must be a tenant / account slug or opaque ID, not raw email / name / PII** — viewer-role users can read it alongside `user_id` / `session_id`. |

---

## PII redaction

When `redact_pii=True` (the default), `input_text` and `output_text`
pass through a regex-based scrubber before leaving the process. The
same scrubber runs on auto-instrumented `chat.completions.create` /
`messages.create` calls AND on manual `sdk.record_llm_call(...)` —
the policy is the same regardless of how the event was generated.

| Pattern | Replacement |
|---|---|
| Email | `[EMAIL]` |
| Credit card (Luhn-validated) | `[CARD]` |
| SSN | `[SSN]` |
| IPv4 | `[IP]` |
| Phone | `[PHONE]` |

Add custom patterns via the public helper on the SDK:

```python
sdk.add_redaction_pattern(
    "UUID",
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
)
```

To disable redaction entirely (rarely a good idea outside dev), pass
`redact_pii=False`.

---

## Providers

| Provider | Status |
|----------|--------|
| OpenAI (`chat.completions.create`) — sync + async + streaming | ✅ v0.2.0 |
| Anthropic (`messages.create`) — sync + async + streaming | ✅ v0.2.0 |
| Google Gemini | 🔜 v0.3 |
| LangChain (via manual API today; native bridge planned) | 🔜 v0.3 |
| LlamaIndex (via manual API today) | 🔜 v0.3 |

For unsupported providers / frameworks, use `sdk.record_llm_call(...)`
to emit events directly — the wire format is the same.

---

## Migrating from `scopecall` v0.1.x

v0.1 used module-level globals (`scopecall.init()` then
`scopecall.trace(...)`). v0.2 returns an instance from `init()`.

The two changes most likely to break callers:

```python
# v0.1 (old)
scopecall.init(api_key="...")               # module-level
with scopecall.trace(feature="x"):
    ...

# v0.2 (new)
sdk = scopecall.init(api_key="...",                # endpoint REQUIRED now
                     endpoint="http://localhost:8080/v1/ingest")
with sdk.trace("x"):                               # name is positional
    ...
```

Other notable changes:

- `endpoint` is required when `api_key` is set (no silent default to
  `https://ingest.scopecall.com` because Cloud isn't live yet).
- Removed dependency on Traceloop / OpenLLMetry.
- Native OpenAI + Anthropic instrumentation (sync + async + streaming)
  via `sdk.instrument(client)`.
- New manual API: `sdk.record_llm_call(...)` and `sdk.add_redaction_pattern(name, regex)`.
- `LLMEvent` wire format adds `kind`, `prompt_version`,
  `input_cost_usd`, `output_cost_usd`, `finish_reason`,
  `cache_read_tokens`, `tool_calls`, and others to match the TS SDK
  parity contract.

---

## Self-hosted setup

See the [main repo README](https://github.com/scopecall/scopecall) for
the full Docker Compose quickstart that brings up the Rust ingest, Rust
processor, ClickHouse, Postgres, Redpanda, Go API, and Next.js
dashboard.

---

## License

[Apache 2.0](LICENSE). Free for any use — self-hosted, modified,
redistributed, or built on top of for commercial products.
