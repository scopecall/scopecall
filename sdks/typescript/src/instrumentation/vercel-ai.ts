/**
 * Vercel AI SDK bridge.
 *
 * The Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, …) is the
 * dominant LLM abstraction in the Next.js ecosystem. Apps call
 * `generateText({ model: openai("gpt-4o"), prompt: "..." })` rather than
 * the OpenAI client directly. Without this bridge, our SDK sees nothing
 * for those apps.
 *
 * Integration point
 * -----------------
 * Vercel models implement the LanguageModelV1 interface from
 * `@ai-sdk/provider`. We don't take a peer dep on that — instead we
 * duck-type the two methods that matter:
 *
 *   doGenerate(options) → { text, usage, finishReason, ... }
 *   doStream(options)   → { stream: ReadableStream<StreamPart>, ... }
 *
 * Every higher-level entry point in the Vercel AI SDK (`generateText`,
 * `streamText`, `generateObject`, `streamObject`, `embed`, …) eventually
 * calls one of these two. Instrumenting them is the universal capture
 * point — we don't have to chase every public function as the surface
 * grows.
 *
 * Usage
 * -----
 *   const sdk = init({ apiKey });
 *   const model = openai("gpt-4o");
 *   sdk.instrument(model, "vercel-ai");
 *   const { text } = await generateText({ model, prompt: "..." });
 *
 * Limitations
 * -----------
 * - Tools/function-calls are captured as `tool_calls` JSON but not
 *   recursed into for cost. Sub-call cost shows up as separate events
 *   when those tools themselves make instrumented LLM calls.
 * - Streaming aggregation: text deltas are concatenated; object-mode
 *   streams (streamObject) emit JSON-mode chunks which we still capture
 *   as text. The `output_text` field will contain the assembled JSON.
 */

import { randomUUID } from "node:crypto";
import type { LLMEvent } from "../wire/llm-event.js";
import { storage } from "../context.js";
import { resolveModel, calculateCost } from "../pricing/resolve.js";
import { Redactor } from "../_redactor.js";
import type { ScopeCallConfig } from "../config.js";
import type { ScopeCallExporter } from "../exporter.js";

declare const __SDK_VERSION__: string;

// ─── Vercel AI SDK shape (duck-typed) ────────────────────────────────────

interface VercelModel {
  /** "openai" | "anthropic" | "google" | "mistral" | … */
  provider: string;
  modelId: string;
  doGenerate?: (options: VercelCallOptions) => Promise<VercelGenerateResult>;
  doStream?: (options: VercelCallOptions) => Promise<VercelStreamResult>;
  [key: string]: unknown;
}

interface VercelPromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
}

interface VercelCallOptions {
  /** LanguageModelV1Prompt — array of role+content messages */
  prompt?: VercelPromptMessage[];
  /** Older SDK versions used `messages` instead of `prompt`. We read either. */
  messages?: VercelPromptMessage[];
  [key: string]: unknown;
}

interface VercelGenerateResult {
  text?: string;
  toolCalls?: Array<Record<string, unknown>>;
  /** "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown" */
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  providerMetadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One frame of the Vercel AI stream. The relevant subset for our purposes. */
interface VercelStreamPart {
  type: string;
  textDelta?: string;
  text?: string;
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  toolCall?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  error?: unknown;
  [k: string]: unknown;
}

interface VercelStreamResult {
  /** A ReadableStream — but we treat it as async-iterable via the standard
   *  ReadableStream async iterator (added to the Web Streams spec in 2022;
   *  available in Node 18+). */
  stream: ReadableStream<VercelStreamPart>;
  [key: string]: unknown;
}

const SCOPECALL_INSTRUMENTED = Symbol.for("scopecall.instrumented");

function isVercelModel(x: unknown): x is VercelModel {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m.provider === "string" &&
    typeof m.modelId === "string" &&
    // At least one of the two — non-streaming-only models could legally
    // omit doStream. We don't insist on both being present.
    (typeof m.doGenerate === "function" || typeof m.doStream === "function")
  );
}

export function instrumentVercelAI(
  model: unknown,
  exporter: ScopeCallExporter,
  config: ScopeCallConfig,
): void {
  if (!isVercelModel(model)) {
    const logger = config.logger === null ? null : (config.logger ?? console);
    logger?.warn(
      "[scopecall] instrumentVercelAI: object doesn't look like a Vercel LanguageModelV1 — skipping",
    );
    return;
  }

  const m = model as VercelModel & Record<string | symbol, unknown>;
  if (m[SCOPECALL_INSTRUMENTED]) return;
  m[SCOPECALL_INSTRUMENTED] = true;

  const redactor =
    config.redact === false
      ? null
      : new Redactor(
          typeof config.redact === "object" ? config.redact.additionalPatterns : undefined,
        );

  // ─── doGenerate ──────────────────────────────────────────────────────
  if (typeof m.doGenerate === "function") {
    const originalGenerate = m.doGenerate.bind(m);
    m.doGenerate = async function (options: VercelCallOptions): Promise<VercelGenerateResult> {
      const ctx = storage.getStore();
      const startTime = Date.now();
      try {
        const result = await originalGenerate(options);
        const latencyMs = Date.now() - startTime;
        exporter.enqueue(
          buildEvent({
            model: m, options, result, config, ctx, startTime, latencyMs,
            status: "success", errorMessage: null, redactor, ttftMs: null,
          }),
        );
        return result;
      } catch (err: unknown) {
        const latencyMs = Date.now() - startTime;
        emitErrorEvent(err, { model: m, options, config, ctx, startTime, latencyMs, redactor, exporter });
        throw err;
      }
    };
  }

  // ─── doStream ────────────────────────────────────────────────────────
  if (typeof m.doStream === "function") {
    const originalStream = m.doStream.bind(m);
    m.doStream = async function (options: VercelCallOptions): Promise<VercelStreamResult> {
      const ctx = storage.getStore();
      const startTime = Date.now();
      let result: VercelStreamResult;
      try {
        result = await originalStream(options);
      } catch (err: unknown) {
        const latencyMs = Date.now() - startTime;
        emitErrorEvent(err, { model: m, options, config, ctx, startTime, latencyMs, redactor, exporter });
        throw err;
      }
      // Replace the stream with one that observes parts on the way through.
      result.stream = wrapReadableStream(result.stream, {
        model: m, options, config, ctx, startTime, redactor, exporter,
      });
      return result;
    };
  }
}

// ─── stream wrapping ─────────────────────────────────────────────────────

interface StreamWrapArgs {
  model: VercelModel;
  options: VercelCallOptions;
  config: ScopeCallConfig;
  ctx: ReturnType<typeof storage.getStore>;
  startTime: number;
  redactor: Redactor | null;
  exporter: ScopeCallExporter;
}

/**
 * Re-emit a ReadableStream through a TransformStream so we observe each
 * chunk on its way to the consumer. Why a TransformStream instead of an
 * async generator: the Vercel AI SDK consumes the stream via reader.read()
 * in several places, not just via Symbol.asyncIterator. A ReadableStream
 * is the universal shape; replacing it with an async iterable would break
 * the downstream code.
 *
 * The trailing `flush` runs when the upstream stream closes (success) and
 * we use the start callback's controller to terminate on upstream cancel.
 * Errors flow through naturally — TransformStream propagates them to the
 * downstream reader and we observe via the `transform` catch.
 */
function wrapReadableStream(
  upstream: ReadableStream<VercelStreamPart>,
  args: StreamWrapArgs,
): ReadableStream<VercelStreamPart> {
  let ttftMs: number | null = null;
  let aggregatedText = "";
  let finishReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls: Array<Record<string, unknown>> = [];
  let status: LLMEvent["status"] = "success";
  let errorMessage: string | null = null;
  let emitted = false;

  function observe(part: VercelStreamPart): void {
    if (ttftMs === null) ttftMs = Date.now() - args.startTime;
    if (typeof part.textDelta === "string") {
      aggregatedText += part.textDelta;
    }
    if (part.type === "finish") {
      if (part.finishReason) finishReason = part.finishReason;
      if (part.usage?.promptTokens != null) inputTokens = part.usage.promptTokens;
      if (part.usage?.completionTokens != null) outputTokens = part.usage.completionTokens;
    }
    if (part.type === "tool-call" || part.type === "tool-call-delta") {
      // Best-effort: keep a record. Real tool-call structure varies between
      // SDK versions; we store the raw chunk so debugging can see it.
      toolCalls.push(part as Record<string, unknown>);
    }
    if (part.type === "error") {
      status = "error";
      errorMessage = String((part.error as { message?: string } | undefined)?.message ?? part.error ?? "stream error");
    }
  }

  function emitEvent(): void {
    if (emitted) return;
    emitted = true;
    const latencyMs = Date.now() - args.startTime;
    const synthesised: VercelGenerateResult = {
      text: aggregatedText,
      finishReason: finishReason ?? undefined,
      usage: { promptTokens: inputTokens, completionTokens: outputTokens },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    args.exporter.enqueue(
      buildEvent({
        model: args.model, options: args.options, result: synthesised,
        config: args.config, ctx: args.ctx, startTime: args.startTime, latencyMs,
        status, errorMessage, redactor: args.redactor, ttftMs,
      }),
    );
  }

  return upstream.pipeThrough(
    new TransformStream<VercelStreamPart, VercelStreamPart>({
      transform(part, controller) {
        observe(part);
        controller.enqueue(part);
      },
      flush() {
        emitEvent();
      },
      // Note: a `cancel` callback would let us emit on consumer-cancel too,
      // but the TransformStream spec doesn't expose that. We rely on the
      // upstream cancellation propagating through and the flush firing.
      // If the consumer cancels mid-stream and the upstream doesn't close,
      // we'd miss the event — acceptable v0.1 tradeoff. Streams that
      // legitimately complete via cancel are rare in agentic apps.
    }),
  );
}

// ─── error path + event building ─────────────────────────────────────────

interface EmitErrorArgs {
  model: VercelModel;
  options: VercelCallOptions;
  config: ScopeCallConfig;
  ctx: ReturnType<typeof storage.getStore>;
  startTime: number;
  latencyMs: number;
  redactor: Redactor | null;
  exporter: ScopeCallExporter;
}

function emitErrorEvent(err: unknown, args: EmitErrorArgs): void {
  const e = err as { statusCode?: number; status?: number; message?: string };
  // Vercel SDK errors expose statusCode (not status) on the most common
  // APICallError class. Check both shapes for robustness.
  const code = e.statusCode ?? e.status;
  const status: LLMEvent["status"] =
    code === 429 ? "rate_limited" : code === 408 ? "timeout" : "error";
  args.exporter.enqueue(
    buildEvent({
      model: args.model, options: args.options, result: null,
      config: args.config, ctx: args.ctx,
      startTime: args.startTime, latencyMs: args.latencyMs,
      status, errorMessage: e.message ?? String(err), redactor: args.redactor,
      ttftMs: null,
    }),
  );
}

/** Fold a Vercel message-content (string OR block array) into a string. */
function foldContent(
  content: VercelPromptMessage["content"] | undefined,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}

function joinPrompt(options: VercelCallOptions): string {
  const msgs = options.prompt ?? options.messages ?? [];
  return msgs.map((m) => `${m.role}: ${foldContent(m.content)}`).join("\n");
}

interface BuildEventArgs {
  model: VercelModel;
  options: VercelCallOptions;
  result: VercelGenerateResult | null;
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
  const { model, options, result, config, ctx, startTime, latencyMs, status, errorMessage, redactor, ttftMs } = args;

  const canonicalModel = resolveModel(model.modelId);
  const inputTokens = result?.usage?.promptTokens ?? 0;
  const outputTokens = result?.usage?.completionTokens ?? 0;
  // Client-side cost is a fallback for unknown models; the processor
  // re-prices server-side. See processor/src/pricing.rs.
  const costUsd = calculateCost(canonicalModel, inputTokens, outputTokens);

  const captureContent = config.captureContent !== false;
  // Default to "" not null — Rust ingest expects String, not Option<String>.
  let inputText = "";
  let outputText = "";
  if (captureContent) {
    const rawIn = joinPrompt(options);
    inputText = redactor ? redactor.redact(rawIn) : rawIn;
    const rawOut = result?.text ?? "";
    if (rawOut) outputText = redactor ? redactor.redact(rawOut) : rawOut;
  }

  // Normalise Vercel's finishReason vocabulary to our cross-provider field.
  // Vercel: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown"
  // We keep the value as-is — the dashboard already handles arbitrary strings.
  const finishReason = result?.finishReason ?? null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkVersion: string =
    typeof (__SDK_VERSION__ as any) !== "undefined" ? (__SDK_VERSION__ as string) : "0.0.0";

  // Tool calls: only stringify if non-empty. Stored as JSON for queryability.
  let toolCallsJson: string | null = null;
  if (result?.toolCalls && result.toolCalls.length > 0) {
    try {
      toolCallsJson = JSON.stringify(result.toolCalls);
    } catch {
      toolCallsJson = null;
    }
  }

  const spanId = randomUUID();
  return {
    span_id: spanId,
    trace_id: ctx?.traceId ?? spanId,
    parent_span_id: ctx?.spanId ?? null,
    timestamp: startTime,
    latency_ms: latencyMs,
    ttft_ms: ttftMs,
    model: canonicalModel,
    // Use the model's own provider field — Vercel exposes the actual
    // provider ("openai", "anthropic", "google", "mistral", …) on every
    // LanguageModelV1, so we don't need to guess.
    provider: model.provider,
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
    finish_reason: finishReason,
    cache_read_tokens: null, // Vercel doesn't expose this uniformly across providers
    original_model: null,
    budget_state: null,
    failure_mode: null,
    tool_calls: toolCallsJson,
    prompt_version: ctx?.promptVersion ?? config.defaultPromptVersion ?? null,
    kind: "llm",
  };
}
