/**
 * OpenAI instrumentation — wraps `chat.completions.create` to capture
 * LLMEvent records without any Traceloop dependency.
 *
 * Uses monkey-patching on the OpenAI client instance rather than
 * InstrumentationBase require-in-the-middle, because the OTel
 * instrumentation base requires the OTel SDK to be fully initialised
 * first and the require hooks to be set up via register.ts.
 *
 * Covers both:
 *   - Non-streaming `chat.completions.create({ stream: false, ... })`
 *   - Streaming `chat.completions.create({ stream: true, ... })` —
 *     measures TTFT, aggregates chunks, fires one LLMEvent at end-of-stream.
 *
 * Streaming uses Symbol.asyncIterator replacement (not class subclassing or
 * Stream.tee()) so the wrapped object preserves every method on the
 * upstream Stream — .toReadableStream(), .controller, .iterator — and only
 * the iteration path is observed. The async generator's `finally` block
 * guarantees the event fires on completion, error, or early break.
 */

import { randomUUID } from "node:crypto";
import type { LLMEvent } from "../wire/llm-event.js";
import { storage } from "../context.js";
import { resolveModel, calculateCost } from "../pricing/resolve.js";
import { Redactor } from "../_redactor.js";
import type { ScopeCallConfig } from "../config.js";
import { resolveTestFlag } from "../config.js";
import type { ScopeCallExporter } from "../exporter.js";

declare const __SDK_VERSION__: string;

interface ChatMessage {
  role: string;
  content: string | null;
}

interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

interface PromptTokensDetails {
  cached_tokens?: number;
}

interface ChatCompletion {
  id: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: PromptTokensDetails;
  };
  choices: Array<{
    message?: { content: string | null; role: string };
    finish_reason?: string | null;
  }>;
}

/**
 * One chunk yielded by a streaming chat.completions.create call.
 * The `usage` field only appears on the final chunk when
 * `stream_options.include_usage: true` is set on the request. We inject
 * that option automatically — see maybeEnableUsage() — but only when the
 * caller didn't already set stream_options explicitly.
 */
interface ChatCompletionChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; role?: string };
    finish_reason?: string | null;
    index?: number;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: PromptTokensDetails;
  };
}

/** OpenAI's Stream<T> is async-iterable. We duck-type it so we don't take
 *  a peer dependency on the `openai` package. */
type AsyncIterableStream<T> = AsyncIterable<T> & { [key: string]: unknown };

// Sentinel symbol — prevents double-patching if instrumentOpenAI() is called twice
const SCOPECALL_INSTRUMENTED = Symbol.for("scopecall.instrumented");

// Duck-type check: does this look like an OpenAI client with a working completions.create?
function isOpenAIClient(client: unknown): client is { chat: { completions: { create: unknown } } } {
  return (
    typeof client === "object" &&
    client !== null &&
    "chat" in client &&
    typeof (client as { chat: { completions?: { create?: unknown } } }).chat?.completions?.create === "function"
  );
}

export function instrumentOpenAI(
  client: unknown,
  exporter: ScopeCallExporter,
  config: ScopeCallConfig
): void {
  if (!isOpenAIClient(client)) return;

  // Idempotency guard: if this client was already instrumented, skip silently.
  // Prevents double-firing when instrumentOpenAI() is called more than once
  // (e.g. in frameworks that reinitialise modules or in test suites).
  const completions = client.chat.completions as Record<string | symbol, unknown>;
  if (completions[SCOPECALL_INSTRUMENTED]) return;
  completions[SCOPECALL_INSTRUMENTED] = true;

  const redactor = config.redact === false
    ? null
    : new Redactor(
        typeof config.redact === "object"
          ? config.redact.additionalPatterns
          : undefined
      );

  const original = (client.chat.completions as { create: unknown }).create as (
    params: ChatCompletionParams
  ) => Promise<ChatCompletion>;

  (client.chat.completions as { create: unknown }).create = async function (
    params: ChatCompletionParams
  ): Promise<ChatCompletion | AsyncIterableStream<ChatCompletionChunk>> {
    const ctx = storage.getStore();
    const startTime = Date.now();

    if (params.stream) {
      // Mutate the params to ask OpenAI for usage in the final chunk. We
      // never overwrite an explicit user choice — only fill in the default.
      // Without this, streaming responses ship with input/output_tokens=0
      // and the cost column reads $0 forever. (External review caught
      // 8 weeks of users asking "why is streaming cost always zero".)
      maybeEnableUsage(params);

      let stream: AsyncIterableStream<ChatCompletionChunk>;
      try {
        stream = (await original.call(this, params)) as unknown as AsyncIterableStream<ChatCompletionChunk>;
      } catch (err: unknown) {
        // Synchronous (pre-iteration) error: e.g. 429 on the initial POST.
        // Build & ship the event right here — there's no stream to wait on.
        const latencyMs = Date.now() - startTime;
        emitErrorEvent(err, { params, config, ctx, startTime, latencyMs, redactor, exporter });
        throw err;
      }
      return wrapStreamingResponse(stream, {
        params, config, ctx, startTime, redactor, exporter,
      });
    }

    // Non-streaming path
    let result: ChatCompletion;
    let status: LLMEvent["status"] = "success";
    let errorMessage: string | null = null;

    try {
      result = await original.call(this, params);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      status = e.status === 429 ? "rate_limited" : e.status === 408 ? "timeout" : "error";
      errorMessage = e.message ?? String(err);
      const latencyMs = Date.now() - startTime;
      const event = buildEvent({
        params, result: null, config, ctx, startTime, latencyMs,
        status, errorMessage, redactor, ttftMs: null,
      });
      exporter.enqueue(event);
      throw err;
    }

    const latencyMs = Date.now() - startTime;
    const event = buildEvent({
      params, result, config, ctx, startTime, latencyMs,
      status, errorMessage, redactor, ttftMs: null,
    });
    exporter.enqueue(event);
    return result;
  };
}

// ─── streaming helpers ──────────────────────────────────────────────────

/** Inject `stream_options: { include_usage: true }` only when neither
 *  stream_options nor include_usage was explicitly set. Respects every
 *  level of user opt-out (whole stream_options object, or just the flag). */
function maybeEnableUsage(params: ChatCompletionParams): void {
  const so = params.stream_options as { include_usage?: boolean } | undefined;
  if (so === undefined) {
    params.stream_options = { include_usage: true };
    return;
  }
  if (typeof so === "object" && so !== null && so.include_usage === undefined) {
    so.include_usage = true;
  }
  // else: user explicitly chose include_usage=false. Honor it; tokens will be 0.
}

interface StreamWrapArgs {
  params: ChatCompletionParams;
  config: ScopeCallConfig;
  ctx: ReturnType<typeof storage.getStore>;
  startTime: number;
  redactor: Redactor | null;
  exporter: ScopeCallExporter;
}

/**
 * Wrap a streaming response so iteration is observed without touching any
 * other method on the upstream object. We replace ONLY the
 * `Symbol.asyncIterator` property — `.controller`, `.toReadableStream()`,
 * `.tee()`, etc. remain functional. This keeps the SDK compatible with
 * users who do non-trivial things with the Stream object.
 *
 * The generator's `finally` block emits the LLMEvent whether iteration
 * completes normally, throws, or is aborted by `break` (which calls
 * iterator.return() under the hood). That's what makes this safe to ship
 * — there's no path where the event is silently lost.
 */
function wrapStreamingResponse(
  stream: AsyncIterableStream<ChatCompletionChunk>,
  args: StreamWrapArgs,
): AsyncIterableStream<ChatCompletionChunk> {
  const originalIterator = (stream as AsyncIterable<ChatCompletionChunk>)[Symbol.asyncIterator].bind(stream);

  // Replace ONLY the iterator method. Cast through unknown because we're
  // augmenting a foreign type; runtime behaviour is correct (we hand back
  // the same object with one property swapped).
  (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<ChatCompletionChunk> })[Symbol.asyncIterator] =
    function () { return observeStream(originalIterator(), args); };

  return stream;
}

async function* observeStream(
  inner: AsyncIterator<ChatCompletionChunk>,
  { params, config, ctx, startTime, redactor, exporter }: StreamWrapArgs,
): AsyncGenerator<ChatCompletionChunk, void, undefined> {
  let ttftMs: number | null = null;
  let aggregatedContent = "";
  let lastFinishReason: string | null = null;
  let usage: ChatCompletion["usage"] | undefined;
  let observedModel: string | undefined;
  let status: LLMEvent["status"] = "success";
  let errorMessage: string | null = null;

  // Adapter from AsyncIterator → AsyncIterable so we can use for-await
  const iterable: AsyncIterable<ChatCompletionChunk> = {
    [Symbol.asyncIterator]: () => inner,
  };

  try {
    for await (const chunk of iterable) {
      if (ttftMs === null) {
        // First chunk seen: this is what TTFT measures. Note that some
        // chunks contain only role headers and no content — that's fine,
        // we want network-arrival latency, not first-content latency.
        ttftMs = Date.now() - startTime;
      }
      if (chunk.model) observedModel = chunk.model;

      const choice = chunk.choices?.[0];
      const deltaContent = choice?.delta?.content;
      if (typeof deltaContent === "string") {
        aggregatedContent += deltaContent;
      }
      const fr = choice?.finish_reason;
      if (fr) lastFinishReason = fr;
      if (chunk.usage) usage = chunk.usage;

      yield chunk;
    }
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    status = e.status === 429 ? "rate_limited" : e.status === 408 ? "timeout" : "error";
    errorMessage = e.message ?? String(err);
    throw err;
  } finally {
    // Build a faux ChatCompletion shape for buildEvent. We have everything
    // it needs from the aggregated stream state. If the stream was broken
    // mid-flight we still emit with whatever was captured — partial data
    // is more useful than nothing for debugging stuck/cancelled streams.
    const latencyMs = Date.now() - startTime;
    const synthesised: ChatCompletion = {
      id: "",
      model: observedModel ?? params.model,
      usage,
      choices: [{
        message: { content: aggregatedContent, role: "assistant" },
        finish_reason: lastFinishReason,
      }],
    };
    const event = buildEvent({
      params, result: synthesised, config, ctx, startTime, latencyMs,
      status, errorMessage, redactor, ttftMs,
    });
    exporter.enqueue(event);
  }
}

interface EmitErrorArgs {
  params: ChatCompletionParams;
  config: ScopeCallConfig;
  ctx: ReturnType<typeof storage.getStore>;
  startTime: number;
  latencyMs: number;
  redactor: Redactor | null;
  exporter: ScopeCallExporter;
}

function emitErrorEvent(err: unknown, args: EmitErrorArgs): void {
  const e = err as { status?: number; message?: string };
  const status: LLMEvent["status"] =
    e.status === 429 ? "rate_limited" : e.status === 408 ? "timeout" : "error";
  const event = buildEvent({
    params: args.params, result: null, config: args.config, ctx: args.ctx,
    startTime: args.startTime, latencyMs: args.latencyMs,
    status, errorMessage: e.message ?? String(err), redactor: args.redactor,
    ttftMs: null,
  });
  args.exporter.enqueue(event);
}

interface BuildEventArgs {
  params: ChatCompletionParams;
  result: ChatCompletion | null;
  config: ScopeCallConfig;
  ctx: ReturnType<typeof storage.getStore>;
  /** Unix epoch milliseconds — the wire format expects a number, not a string. */
  startTime: number;
  latencyMs: number;
  status: LLMEvent["status"];
  errorMessage: string | null;
  redactor: Redactor | null;
  /** Milliseconds from request-issued to first stream chunk. `null` for
   *  non-streaming calls or when the stream errored before the first chunk. */
  ttftMs: number | null;
}

function buildEvent(args: BuildEventArgs): LLMEvent {
  const { params, result, config, ctx, startTime, latencyMs, status, errorMessage, redactor, ttftMs } = args;

  const canonicalModel = resolveModel(result?.model ?? params.model);
  const inputTokens = result?.usage?.prompt_tokens ?? 0;
  const outputTokens = result?.usage?.completion_tokens ?? 0;
  const costUsd = calculateCost(canonicalModel, inputTokens, outputTokens);

  const captureContent = config.captureContent !== false;
  // Default to "" not null — see wire/llm-event.ts on why null breaks the
  // Rust ingest. captureContent=false leaves both as "" (no content
  // recorded, no body bytes sent).
  let inputText = "";
  let outputText = "";

  if (captureContent) {
    const raw = (params.messages ?? []).map((m) => `${m.role}: ${m.content ?? ""}`).join("\n");
    inputText = redactor ? redactor.redact(raw) : raw;
    const content = result?.choices[0]?.message?.content ?? null;
    if (content !== null) {
      outputText = redactor ? redactor.redact(content) : content;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkVersion: string = typeof (__SDK_VERSION__ as any) !== "undefined"
    ? (__SDK_VERSION__ as string)
    : "0.0.0";

  const spanId = randomUUID();
  return {
    span_id: spanId,
    // Generate a trace_id when no trace context exists — represents a
    // single-span trace (trace_id === span_id). Rust ingest requires a
    // non-null trace_id (services-rust/common/src/event.rs). Without this
    // generation step, every un-traced call was rejected by the ingest.
    trace_id: ctx?.traceId ?? spanId,
    // Read the active trace span's id from AsyncLocalStorage and use it
    // as this LLM call's parent. When there's no enclosing trace() (call
    // made outside a trace context), parent_span_id is null — the call
    // forms a single-span trace. This is what makes nested LLM calls
    // inside sdk.trace() appear under the trace on the dashboard.
    parent_span_id: ctx?.spanId ?? null,
    timestamp: startTime, // Unix epoch ms (number), not ISO string

    latency_ms: latencyMs,
    ttft_ms: ttftMs,
    model: canonicalModel,
    provider: "openai",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    status,
    error_message: errorMessage,
    input_text: inputText,
    output_text: outputText,
    feature_name: ctx?.name ?? config.defaultFeature ?? null,
    user_id: config.defaultUserId ?? null,
    session_id: config.defaultSessionId ?? null,
    customer_id: ctx?.customerId ?? null,
    is_test: resolveTestFlag(config),
    attempt_number: 1,
    retry_reason: null,
    environment: config.environment ?? "production",
    sdk_version: sdkVersion,
    extra: null,
    finish_reason: result?.choices[0]?.finish_reason ?? null,
    cache_read_tokens: result?.usage?.prompt_tokens_details?.cached_tokens ?? null,
    original_model: null, // populated by fallback routing layer; not known here
    budget_state: null,
    failure_mode: null,
    tool_calls: null,
    // Precedence: trace context (set by sdk.trace(.., .., {promptVersion}))
    // → config default → null. Keeps the per-trace tag authoritative.
    prompt_version: ctx?.promptVersion ?? config.defaultPromptVersion ?? null,
    // Instrumenter events are LLM calls by definition. The wire DTO
    // defaults this to "llm" when missing; set it explicitly so the
    // emitted payload is unambiguous on the wire trace.
    kind: "llm",
  };
}
