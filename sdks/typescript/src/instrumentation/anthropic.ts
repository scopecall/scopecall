/**
 * Anthropic instrumentation — wraps `messages.create` to capture LLMEvent
 * records. Mirrors the OpenAI instrumentation's monkey-patch + observe-via-
 * Symbol.asyncIterator pattern.
 *
 * Covered:
 *   - Non-streaming `client.messages.create({ stream: false, ... })`
 *   - Streaming `client.messages.create({ stream: true, ... })` — measures
 *     TTFT, aggregates content_block_delta text, captures stop_reason and
 *     final usage from message_delta.
 *
 * Anthropic stream protocol (the relevant subset):
 *   message_start        { message: { id, model, usage: { input_tokens, output_tokens } } }
 *   content_block_start  { index, content_block: { type, text? } }
 *   content_block_delta  { index, delta: { type: "text_delta", text } }
 *   content_block_stop   { index }
 *   message_delta        { delta: { stop_reason, stop_sequence }, usage: { output_tokens } }
 *   message_stop         {}
 *   ping                 {} (keepalive — ignored)
 *
 * Note: usage on `message_start` reports the prompt tokens, but
 * `output_tokens` there is a 1-token placeholder. The authoritative
 * output_tokens count arrives on `message_delta` near the end. We track
 * BOTH and resolve at end-of-stream so an interrupted stream still
 * reports the best-known totals.
 */

import { randomUUID } from "node:crypto";
import type { LLMEvent } from "../wire/llm-event.js";
import { storage } from "../context.js";
import { resolveModel, calculateCost } from "../pricing/resolve.js";
import { Redactor } from "../_redactor.js";
import type { ScopeCallConfig } from "../config.js";
import type { ScopeCallExporter } from "../exporter.js";

declare const __SDK_VERSION__: string;

// ─── Anthropic shape (duck-typed; we don't take a peer dep on the SDK) ───

interface AnthropicMessage {
  role: string;
  /** Anthropic accepts content as either a string or an array of blocks.
   *  We aggregate to a string for input_text — see joinMessages(). */
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
}

interface AnthropicParams {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  /** System prompt — string or block array. Folded into input_text. */
  system?: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  stream?: boolean;
  [key: string]: unknown;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicMessageResponse {
  id: string;
  type: string; // "message"
  model: string;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage: AnthropicUsage;
}

/** Discriminated union over the events Anthropic streams. */
type AnthropicStreamEvent =
  | { type: "message_start"; message: { model?: string; usage?: AnthropicUsage } }
  | { type: "content_block_start"; index: number; content_block: { type: string; text?: string } }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string | null; stop_sequence?: string | null }; usage?: { output_tokens?: number } }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: string; [k: string]: unknown };

type AsyncIterableStream<T> = AsyncIterable<T> & { [key: string]: unknown };

const SCOPECALL_INSTRUMENTED = Symbol.for("scopecall.instrumented");

function isAnthropicClient(client: unknown): client is { messages: { create: unknown } } {
  return (
    typeof client === "object" &&
    client !== null &&
    "messages" in client &&
    typeof (client as { messages: { create?: unknown } }).messages?.create === "function"
  );
}

export function instrumentAnthropic(
  client: unknown,
  exporter: ScopeCallExporter,
  config: ScopeCallConfig,
): void {
  if (!isAnthropicClient(client)) {
    // Duck-type mismatch — log so users debugging "why no events" can spot it.
    const logger = config.logger === null ? null : (config.logger ?? console);
    logger?.warn(
      "[scopecall] instrumentAnthropic: client doesn't expose messages.create — skipping",
    );
    return;
  }

  const messages = client.messages as Record<string | symbol, unknown>;
  if (messages[SCOPECALL_INSTRUMENTED]) return;
  messages[SCOPECALL_INSTRUMENTED] = true;

  const redactor =
    config.redact === false
      ? null
      : new Redactor(
          typeof config.redact === "object" ? config.redact.additionalPatterns : undefined,
        );

  const original = (client.messages as { create: unknown }).create as (
    params: AnthropicParams,
  ) => Promise<AnthropicMessageResponse> | Promise<AsyncIterableStream<AnthropicStreamEvent>>;

  (client.messages as { create: unknown }).create = async function (
    params: AnthropicParams,
  ): Promise<AnthropicMessageResponse | AsyncIterableStream<AnthropicStreamEvent>> {
    const ctx = storage.getStore();
    const startTime = Date.now();

    if (params.stream) {
      let stream: AsyncIterableStream<AnthropicStreamEvent>;
      try {
        stream = (await original.call(this, params)) as AsyncIterableStream<AnthropicStreamEvent>;
      } catch (err: unknown) {
        const latencyMs = Date.now() - startTime;
        emitErrorEvent(err, { params, config, ctx, startTime, latencyMs, redactor, exporter });
        throw err;
      }
      return wrapStreamingResponse(stream, { params, config, ctx, startTime, redactor, exporter });
    }

    // Non-streaming
    let result: AnthropicMessageResponse;
    let status: LLMEvent["status"] = "success";
    let errorMessage: string | null = null;

    try {
      result = (await original.call(this, params)) as AnthropicMessageResponse;
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      status = e.status === 429 ? "rate_limited" : e.status === 408 ? "timeout" : "error";
      errorMessage = e.message ?? String(err);
      const latencyMs = Date.now() - startTime;
      exporter.enqueue(
        buildEvent({
          params, result: null, config, ctx, startTime, latencyMs,
          status, errorMessage, redactor, ttftMs: null,
        }),
      );
      throw err;
    }

    const latencyMs = Date.now() - startTime;
    exporter.enqueue(
      buildEvent({
        params, result, config, ctx, startTime, latencyMs,
        status, errorMessage, redactor, ttftMs: null,
      }),
    );
    return result;
  };
}

// ─── streaming wrapper ───────────────────────────────────────────────────

interface StreamWrapArgs {
  params: AnthropicParams;
  config: ScopeCallConfig;
  ctx: ReturnType<typeof storage.getStore>;
  startTime: number;
  redactor: Redactor | null;
  exporter: ScopeCallExporter;
}

function wrapStreamingResponse(
  stream: AsyncIterableStream<AnthropicStreamEvent>,
  args: StreamWrapArgs,
): AsyncIterableStream<AnthropicStreamEvent> {
  // Preserve every property on the upstream Stream — only the iterator
  // method is replaced. Same pattern as the OpenAI wrapper; see that file
  // for the why.
  const originalIterator = (stream as AsyncIterable<AnthropicStreamEvent>)[Symbol.asyncIterator].bind(stream);
  (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<AnthropicStreamEvent> })[Symbol.asyncIterator] =
    function () { return observeStream(originalIterator(), args); };
  return stream;
}

async function* observeStream(
  inner: AsyncIterator<AnthropicStreamEvent>,
  { params, config, ctx, startTime, redactor, exporter }: StreamWrapArgs,
): AsyncGenerator<AnthropicStreamEvent, void, undefined> {
  let ttftMs: number | null = null;
  let aggregatedText = "";
  let observedModel: string | undefined;
  let stopReason: string | null = null;
  // Anthropic splits usage across two events: message_start carries
  // input_tokens (and a placeholder output_tokens=1), message_delta carries
  // the real output_tokens. Hold both and resolve at end-of-stream.
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let status: LLMEvent["status"] = "success";
  let errorMessage: string | null = null;

  const iterable: AsyncIterable<AnthropicStreamEvent> = {
    [Symbol.asyncIterator]: () => inner,
  };

  try {
    for await (const ev of iterable) {
      if (ttftMs === null) ttftMs = Date.now() - startTime;

      switch (ev.type) {
        case "message_start": {
          const m = (ev as { message?: { model?: string; usage?: AnthropicUsage } }).message;
          if (m?.model) observedModel = m.model;
          if (m?.usage) {
            inputTokens     = m.usage.input_tokens;
            cacheReadTokens = m.usage.cache_read_input_tokens;
            // Don't trust output_tokens from message_start — it's a
            // placeholder (often 1). Wait for message_delta.
          }
          break;
        }
        case "content_block_delta": {
          const d = (ev as { delta?: { type?: string; text?: string } }).delta;
          if (d?.type === "text_delta" && typeof d.text === "string") {
            aggregatedText += d.text;
          }
          break;
        }
        case "message_delta": {
          const d = (ev as { delta?: { stop_reason?: string | null } }).delta;
          if (d?.stop_reason) stopReason = d.stop_reason;
          const u = (ev as { usage?: { output_tokens?: number } }).usage;
          if (typeof u?.output_tokens === "number") outputTokens = u.output_tokens;
          break;
        }
        // message_stop / ping / content_block_* are no-ops for our purposes
      }

      yield ev;
    }
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    status = e.status === 429 ? "rate_limited" : e.status === 408 ? "timeout" : "error";
    errorMessage = e.message ?? String(err);
    throw err;
  } finally {
    const latencyMs = Date.now() - startTime;
    // Synthesise a response object out of the accumulated stream state.
    const synthesised: AnthropicMessageResponse = {
      id: "",
      type: "message",
      model: observedModel ?? params.model,
      content: aggregatedText ? [{ type: "text", text: aggregatedText }] : [],
      stop_reason: stopReason,
      usage: {
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
        cache_read_input_tokens: cacheReadTokens,
      },
    };
    exporter.enqueue(
      buildEvent({
        params, result: synthesised, config, ctx, startTime, latencyMs,
        status, errorMessage, redactor, ttftMs,
      }),
    );
  }
}

// ─── shared helpers ──────────────────────────────────────────────────────

interface EmitErrorArgs {
  params: AnthropicParams;
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
  args.exporter.enqueue(
    buildEvent({
      params: args.params, result: null, config: args.config, ctx: args.ctx,
      startTime: args.startTime, latencyMs: args.latencyMs,
      status, errorMessage: e.message ?? String(err), redactor: args.redactor,
      ttftMs: null,
    }),
  );
}

/** Fold Anthropic's content shape (string OR block array) into a single string.
 *  Used for both input_text (prompt + system) and output_text (response). */
function joinContent(
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }> | undefined,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}

function joinMessages(params: AnthropicParams): string {
  // system can be string or block array (mirrors message content shape).
  const sysText = joinContent(params.system as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  const msgLines = (params.messages ?? []).map((m) => `${m.role}: ${joinContent(m.content)}`);
  return sysText
    ? `system: ${sysText}\n${msgLines.join("\n")}`
    : msgLines.join("\n");
}

interface BuildEventArgs {
  params: AnthropicParams;
  result: AnthropicMessageResponse | null;
  config: ScopeCallConfig;
  ctx: ReturnType<typeof storage.getStore>;
  startTime: number;
  latencyMs: number;
  status: LLMEvent["status"];
  errorMessage: string | null;
  redactor: Redactor | null;
  ttftMs: number | null;
}

function buildEvent(args: BuildEventArgs): LLMEvent {
  const { params, result, config, ctx, startTime, latencyMs, status, errorMessage, redactor, ttftMs } = args;

  const canonicalModel = resolveModel(result?.model ?? params.model);
  const inputTokens  = result?.usage?.input_tokens  ?? 0;
  const outputTokens = result?.usage?.output_tokens ?? 0;
  // Server-side pricing will overwrite this in the processor; we still
  // compute client-side as a fallback for unknown models.
  const costUsd = calculateCost(canonicalModel, inputTokens, outputTokens);

  const captureContent = config.captureContent !== false;
  // Default to "" not null — Rust ingest expects String, not Option<String>.
  let inputText = "";
  let outputText = "";

  if (captureContent) {
    const rawIn = joinMessages(params);
    inputText = redactor ? redactor.redact(rawIn) : rawIn;
    const rawOut = joinContent(result?.content);
    if (rawOut) outputText = redactor ? redactor.redact(rawOut) : rawOut;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkVersion: string =
    typeof (__SDK_VERSION__ as any) !== "undefined" ? (__SDK_VERSION__ as string) : "0.0.0";

  const spanId = randomUUID();
  return {
    span_id: spanId,
    // Synthesise trace_id for un-traced calls. Same contract as OpenAI
    // instrumentation; see wire/llm-event.ts for the Rust ingest invariant.
    trace_id: ctx?.traceId ?? spanId,
    // See openai.ts for the parenting rationale — keeps both providers
    // consistent so a workflow that mixes OpenAI + Anthropic calls
    // still builds a coherent tree.
    parent_span_id: ctx?.spanId ?? null,
    timestamp: startTime,
    latency_ms: latencyMs,
    ttft_ms: ttftMs,
    model: canonicalModel,
    provider: "anthropic",
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
    environment: config.environment ?? "production",
    sdk_version: sdkVersion,
    extra: null,
    // Map Anthropic's stop_reason into our cross-provider finish_reason field.
    // Anthropic values: end_turn | max_tokens | stop_sequence | tool_use
    finish_reason: result?.stop_reason ?? null,
    cache_read_tokens: result?.usage?.cache_read_input_tokens ?? null,
    original_model: null,
    budget_state: null,
    failure_mode: null,
    tool_calls: null,
    // See openai.ts buildEvent for the precedence rationale — trace context
    // wins over the config default. Keeps both providers consistent.
    prompt_version: ctx?.promptVersion ?? config.defaultPromptVersion ?? null,
    kind: "llm",
  };
}
