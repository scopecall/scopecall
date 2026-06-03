/**
 * @scopecall/scopecall-js — public API
 *
 * Usage:
 *   import { init } from "@scopecall/scopecall-js";
 *   const sdk = init({ apiKey: "sc_..." });
 *   await sdk.trace("my-feature", async () => {
 *     const res = await openai.chat.completions.create({ ... });
 *     return res;
 *   });
 */

import { randomUUID } from "node:crypto";
import { validate, ConfigError } from "./config.js";
import type { ScopeCallConfig } from "./config.js";
import { ScopeCallExporter, attachProcessHooks } from "./exporter.js";
import { trace as contextTrace, storage } from "./context.js";
import type { TraceContext, TraceOptions } from "./context.js";
import { instrumentOpenAI } from "./instrumentation/openai.js";
import { instrumentAnthropic } from "./instrumentation/anthropic.js";
import { instrumentVercelAI } from "./instrumentation/vercel-ai.js";
import type { LLMEvent } from "./wire/llm-event.js";

declare const __SDK_VERSION__: string;

export type { ScopeCallConfig, TraceContext, TraceOptions };
export { ConfigError };

// ---------------------------------------------------------------------------
// SDK instance
// ---------------------------------------------------------------------------

export interface ScopeCallSDK {
  /**
   * Run an async function within a named trace span.
   * All LLM calls inside `fn` will be attributed to this span.
   *
   * @param opts.promptVersion  Tags every LLM call inside `fn` with this
   *   identifier — surfaces in the Prompts page for KPI attribution.
   */
  trace<T>(
    name: string,
    fn: (ctx: TraceContext) => Promise<T>,
    opts?: TraceOptions,
  ): Promise<T>;

  /**
   * Instrument a provider's client/model instance so subsequent calls emit
   * trace events.
   *
   * - "openai":     OpenAI client (chat.completions.create)
   * - "anthropic":  Anthropic client (messages.create)
   * - "vercel-ai":  Vercel AI SDK LanguageModelV1 (the object returned by
   *                 `openai("gpt-4o")` from `@ai-sdk/openai`, etc.). Covers
   *                 generateText / streamText / generateObject / streamObject
   *                 because they all bottom out in model.doGenerate / doStream.
   *
   * Defaults to "openai" for backwards compatibility.
   */
  instrument(client: unknown, provider?: "openai" | "anthropic" | "vercel-ai"): void;

  /** Flush all queued events synchronously. Resolves when queue is empty. */
  flush(timeoutMs?: number): Promise<void>;

  /** Shut down the SDK — flushes, closes transport. */
  close(): Promise<void>;

  /** True if the SDK was initialised with disabled:true */
  readonly disabled: boolean;
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let _instance: ScopeCallSDK | null = null;

/** @internal — exposed for testing only */
export function _resetInstance(): void {
  _instance = null;
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

/**
 * Initialise the ScopeCall SDK.
 *
 * Idempotent: calling init() more than once returns the first instance
 * and logs a warning. Use _resetInstance() in tests to get a fresh instance.
 */
export function init(config: ScopeCallConfig = {}): ScopeCallSDK {
  if (_instance) {
    // Suppress the warning when init() is called with no meaningful config —
    // that's the documented pattern (register.ts initialises first; user code
    // calls init() with no args to get the same instance). Only warn when
    // a second call passes actual config that will be silently ignored.
    const hasConfig = Object.keys(config).some(
      (k) => config[k as keyof ScopeCallConfig] !== undefined
    );
    if (hasConfig) {
      const logger = config.logger === null ? null : (config.logger ?? console);
      logger?.warn(
        "[scopecall] init() called more than once with config — config ignored, returning existing instance"
      );
    }
    return _instance;
  }

  validate(config); // throws ConfigError if no transport configured (and not disabled)

  if (config.disabled) {
    _instance = makeDisabledSDK();
    return _instance;
  }

  const exporter = new ScopeCallExporter(config);
  attachProcessHooks(exporter);

  const sdk: ScopeCallSDK = {
    disabled: false,

    async trace<T>(
      name: string,
      fn: (ctx: TraceContext) => Promise<T>,
      opts?: TraceOptions,
    ): Promise<T> {
      // Capture the TraceContext that contextTrace creates so we can emit
      // a workflow-span event after the inner fn returns. Without that
      // event, LLM calls inside reference a parent_span_id (ctx.spanId)
      // that doesn't exist as a row in ClickHouse — the trace tree
      // query's JOIN finds no parent and the workflow node is invisible.
      // (Round-3 external review P0.)
      const startTime = Date.now();
      let status: LLMEvent["status"] = "success";
      let errorMessage: string | null = null;
      let capturedCtx: TraceContext | null = null;
      try {
        return await contextTrace(name, async (ctx) => {
          capturedCtx = ctx;
          return fn(ctx);
        }, opts);
      } catch (err: unknown) {
        // Map common error shapes to LLMEvent status. The workflow span
        // status reflects whether the trace BLOCK succeeded — distinct
        // from individual LLM-call statuses inside (which can still fail
        // even when the block as a whole completes).
        const e = err as { status?: number; message?: string };
        status = e.status === 429 ? "rate_limited"
               : e.status === 408 ? "timeout"
               : "error";
        errorMessage = e.message ?? String(err);
        throw err;
      } finally {
        if (capturedCtx) {
          const latencyMs = Date.now() - startTime;
          exporter.enqueue(buildWorkflowEvent({
            ctx: capturedCtx, latencyMs, status, errorMessage, config,
          }));
        }
      }
    },

    instrument(
      client: unknown,
      provider: "openai" | "anthropic" | "vercel-ai" = "openai",
    ): void {
      switch (provider) {
        case "openai":
          instrumentOpenAI(client, exporter, config);
          break;
        case "anthropic":
          instrumentAnthropic(client, exporter, config);
          break;
        case "vercel-ai":
          instrumentVercelAI(client, exporter, config);
          break;
      }
    },

    async flush(timeoutMs?: number): Promise<void> {
      return exporter.flush(timeoutMs);
    },

    async close(): Promise<void> {
      return exporter.close();
    },
  };

  _instance = sdk;
  return sdk;
}

// ---------------------------------------------------------------------------
// Disabled SDK — no-op for every call
// ---------------------------------------------------------------------------

function makeDisabledSDK(): ScopeCallSDK {
  return {
    disabled: true,
    async trace<T>(
      _name: string,
      fn: (ctx: TraceContext) => Promise<T>,
      _opts?: TraceOptions,
    ): Promise<T> {
      const ctx: TraceContext = {
        traceId: randomUUID(),
        spanId: randomUUID(),
        parentSpanId: null,
        name: _name,
        promptVersion: _opts?.promptVersion ?? null,
      };
      return storage.run(ctx, () => fn(ctx));
    },
    instrument(): void { /* no-op */ },
    async flush(): Promise<void> { /* no-op */ },
    async close(): Promise<void> { /* no-op */ },
  };
}

// Re-export trace standalone for users who don't need the full SDK object
export { contextTrace as trace };

// ─── Workflow-span emission ──────────────────────────────────────────────
//
// The synthetic event sdk.trace() emits at end-of-block. Same wire shape
// as an LLM event (LLMEvent), but with kind="workflow" and zero values for
// the LLM-specific fields. Stored as a row in llm_calls with kind='workflow'
// so the trace-tree JOIN finds a real parent for the LLM-call children.
//
// What we DELIBERATELY omit / zero out:
//   - model / provider — empty strings; this isn't a provider call.
//   - input_tokens / output_tokens / cost_usd — zero; no LLM cost.
//   - input_text / output_text — empty; the trace block has no payload of
//     its own (its children carry the prompts).
//   - finish_reason / cache_read_tokens / tool_calls — null; provider-only.
//
// What we DO populate:
//   - span_id = ctx.spanId (the trace-context's own span id — this is the
//     id LLM calls inside used as their parent_span_id).
//   - trace_id = ctx.traceId (shared with all child LLM calls).
//   - parent_span_id = ctx.parentSpanId (links to outer trace span when nested).
//   - timestamp = startTime, latency_ms = elapsed.
//   - feature_name = trace name, so the Cost / Sessions / etc. breakdowns
//     attribute the workflow correctly even when no LLM call inside ran.
//   - prompt_version inherited via the same precedence as LLM events.
//   - status from the trace block's success/failure.
interface BuildWorkflowEventArgs {
  ctx: TraceContext;
  latencyMs: number;
  status: LLMEvent["status"];
  errorMessage: string | null;
  config: ScopeCallConfig;
}

function buildWorkflowEvent(args: BuildWorkflowEventArgs): LLMEvent {
  const { ctx, latencyMs, status, errorMessage, config } = args;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkVersion: string =
    typeof (__SDK_VERSION__ as any) !== "undefined" ? (__SDK_VERSION__ as string) : "0.0.0";
  return {
    span_id: ctx.spanId,
    trace_id: ctx.traceId,
    parent_span_id: ctx.parentSpanId,
    timestamp: Date.now() - latencyMs, // start-of-block, not end
    latency_ms: latencyMs,
    ttft_ms: null,
    model: "",
    provider: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    status,
    error_message: errorMessage,
    input_text: "",
    output_text: "",
    feature_name: ctx.name ?? config.defaultFeature ?? null,
    user_id: config.defaultUserId ?? null,
    session_id: config.defaultSessionId ?? null,
    environment: config.environment ?? "production",
    sdk_version: sdkVersion,
    extra: null,
    finish_reason: null,
    cache_read_tokens: null,
    original_model: null,
    budget_state: null,
    failure_mode: null,
    tool_calls: null,
    prompt_version: ctx.promptVersion ?? config.defaultPromptVersion ?? null,
    kind: "workflow",
  };
}
