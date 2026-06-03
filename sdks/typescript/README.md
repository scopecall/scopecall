# @scopecall/scopecall-js

TypeScript SDK for [ScopeCall](https://scopecall.com) — source-available, self-hostable AI observability.

[![npm](https://img.shields.io/npm/v/@scopecall/scopecall-js)](https://www.npmjs.com/package/@scopecall/scopecall-js)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](../../LICENSE)

---

## Install

```bash
npm install @scopecall/scopecall-js
# or
pnpm add @scopecall/scopecall-js
# or
yarn add @scopecall/scopecall-js
```

---

## Quick start

```typescript
import { init } from "@scopecall/scopecall-js";
import OpenAI from "openai";

// Initialize once at app startup. `init()` returns the SDK instance.
const sdk = init({
  apiKey: "sc_live_xxx",                       // from your ScopeCall dashboard
  endpoint: "http://localhost:8080/v1/ingest", // required: your self-hosted ingest URL
});

// Instrument your OpenAI client in place — all chat.completions.create
// calls through this instance are traced automatically.
const openai = new OpenAI();
sdk.instrument(openai);

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});

// Traces appear in your dashboard within seconds
```

---

## Configuration

```typescript
const sdk = init({
  apiKey: "sc_live_xxx",                       // required (or set `output`/`debug`/custom `transport`)
  endpoint: "http://localhost:8080/v1/ingest", // required when using apiKey — point at your self-hosted ingest
  environment: "production",                   // optional; defaults to "production"
  captureContent: true,                        // optional; record prompts/completions (default true)
  redact: true,                                // optional; PII redaction (default true)
  batchSize: 50,                               // optional; events per HTTP batch
  maxRetries: 3,                               // optional; retry attempts on transient failure
  debug: false,                                // optional; route events to console instead of HTTP
});
```

> **No hosted-cloud default yet.** A managed default endpoint will return
> when ScopeCall Cloud is live. Until then, `init()` throws `ConfigError`
> if `apiKey` is set without `endpoint` — fail-fast is safer than
> silently sending events to a domain that doesn't exist.

---

## Optional metadata per call

Attribute calls to a feature, user, or session via the `trace()` helper.
Any LLM calls made inside the callback inherit this context.

```typescript
await sdk.trace("customer-support", async () => {
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [...],
  });
});
```

For SDK-wide defaults (applied to every call), set them on `init()`:

```typescript
const sdk = init({
  apiKey: "sc_live_xxx",
  endpoint: "http://localhost:8080/v1/ingest",
  defaultFeature: "customer-support",
  defaultUserId: "user_123",
  defaultSessionId: "session_abc",
});
```

---

## Tracking prompt versions

Tag a trace with `promptVersion` so the Prompts page can show cost / latency /
error-rate per iteration. When you ship a new prompt, bump the version and
see the deltas immediately:

```typescript
await sdk.trace("billing-agent", async () => {
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "system", content: PROMPT_V3 }, ...],
  });
}, { promptVersion: "v3" });
```

Nested traces inherit the parent's `promptVersion`. To clear it on a child
span, pass `{ promptVersion: null }`.

For apps where every call belongs to one version (e.g. tagged by deploy/SHA),
set the SDK-wide default and skip the per-trace arg:

```typescript
const sdk = init({
  apiKey: "sc_live_xxx",
  endpoint: "http://localhost:8080/v1/ingest",
  defaultPromptVersion: process.env.RELEASE_SHA, // tag every call
});
```

Precedence: `trace()` opts → parent trace's value → `defaultPromptVersion` → null.

---

## Streaming

Streaming `chat.completions.create({ stream: true, ... })` is captured the same
way as non-streaming calls. TTFT (time to first token) is recorded
automatically, content is aggregated across chunks, and one event is emitted
when the stream completes (or is aborted by the consumer).

```typescript
const stream = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "tell me a story" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
// One trace appears with: ttft_ms, latency_ms, output_text, input/output_tokens
```

The SDK automatically adds `stream_options.include_usage: true` to your
request so token counts arrive in the final chunk. If you explicitly set
`include_usage: false`, that choice is honored and token counts will be 0.

---

## What gets captured

Every `chat.completions.create` call captures:

| Field | Description |
|-------|-------------|
| `model` | Canonical model name (e.g. `gpt-4o`, `claude-3-5-sonnet`) |
| `provider` | Detected provider (`openai` \| `anthropic`) |
| `input_tokens` | Prompt token count |
| `output_tokens` | Completion token count |
| `cost_usd` | Calculated cost in USD |
| `latency_ms` | End-to-end latency |
| `ttft_ms` | Time to first token (streaming) |
| `finish_reason` | `stop`, `length`, `tool_calls`, etc. |
| `cache_read_tokens` | OpenAI prompt cache hits |
| `status` | `success` or `error` |
| `error_message` | Error detail on failure |
| `input_text` | Full prompt (redacted per your PII config) |
| `output_text` | Full completion |
| `prompt_version` | Prompt iteration label from `trace()` or config — powers the Prompts page |

---

## Providers

| Provider | Status |
|----------|--------|
| OpenAI   | ✅ v0.1.0 — `chat.completions.create` (streaming + non-streaming) |
| Anthropic | ✅ v0.1.1 — `messages.create` (streaming + non-streaming) |
| Vercel AI SDK | ✅ v0.1.1 — `generateText`, `streamText`, `generateObject`, `streamObject` (every entry point that hits `doGenerate` / `doStream`) |
| Gemini   | 🔜 v0.1.2 |

### Anthropic usage

```typescript
import { init } from "@scopecall/scopecall-js";
import Anthropic from "@anthropic-ai/sdk";

const sdk = init({
  apiKey: "sc_live_xxx",
  endpoint: "http://localhost:8080/v1/ingest",
});
const anthropic = new Anthropic();
sdk.instrument(anthropic, "anthropic");

const msg = await anthropic.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});
```

Streaming works the same way — pass `stream: true` and iterate the result.
TTFT and content are captured automatically; final token counts come from
the `message_delta` event Anthropic emits near end-of-stream.

### Vercel AI SDK usage

Instrument the model object that providers like `@ai-sdk/openai` return.
All higher-level entry points (`generateText`, `streamText`,
`generateObject`, `streamObject`) bottom out in this model's
`doGenerate` / `doStream`, so a single instrument call captures everything:

```typescript
import { init } from "@scopecall/scopecall-js";
import { generateText, streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const sdk = init({
  apiKey: "sc_live_xxx",
  endpoint: "http://localhost:8080/v1/ingest",
});
const model = openai("gpt-4o");
sdk.instrument(model, "vercel-ai");

// Non-streaming
const { text } = await generateText({
  model,
  prompt: "Hello",
});

// Streaming
const result = streamText({ model, prompt: "Tell me a story" });
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

Works the same with `@ai-sdk/anthropic`, `@ai-sdk/google`, etc. — the
bridge reads the `provider` field off the model object so the trace's
`provider` field is set correctly per call.

---

## Self-hosted setup

See the [main repo README](../../README.md) for the full Docker Compose quickstart.

---

## License

[BUSL-1.1](LICENSE) — free to use for internal applications. Managed hosting for third parties requires a commercial agreement.
