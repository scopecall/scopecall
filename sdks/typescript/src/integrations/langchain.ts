/**
 * LangChain (JS) integration for ScopeCall — parity with the Python adapter.
 *
 * LangChain fires discrete callback events (`handleChainStart` /
 * `handleLLMEnd` …) with `runId` / `parentRunId`. This handler maps them to
 * the ScopeCall span hierarchy via the SDK's manual lifecycle API
 * (`startSpan` / `endSpan` / `recordLlmCall`):
 *
 *   chain → agent span,  tool/retriever → step span,  llm → llm event.
 *
 * Usage:
 *
 *     import { init } from "@scopecall/scopecall-js";
 *     import { ScopeCallCallbackHandler } from "@scopecall/scopecall-js/integrations/langchain";
 *
 *     init({ apiKey, endpoint });
 *     const handler = new ScopeCallCallbackHandler();
 *     await chain.invoke(input, { callbacks: [handler] });
 *
 * No hard dependency on langchain — duck-typed. No-op when ScopeCall is
 * uninitialized; never throws into LangChain.
 */

import { getActive, type ScopeCallSDK } from "../index.js";
import type { TraceContext } from "../context.js";

interface HandlerOpts {
  sdk?: ScopeCallSDK;
  customerId?: string | null;
  promptVersion?: string | null;
}

// Minimal shape of a LangChain LLMResult we read token usage from.
interface LLMResultish {
  llmOutput?: {
    tokenUsage?: { promptTokens?: number; completionTokens?: number };
    estimatedTokenUsage?: { promptTokens?: number; completionTokens?: number };
    model_name?: string;
    model?: string;
  } | null;
  generations?: Array<Array<{ message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } }>>;
}

export class ScopeCallCallbackHandler {
  // LangChain requires a `name` on callback handlers.
  readonly name = "ScopeCallCallbackHandler";
  // Keep handler attached to nested runs.
  readonly awaitHandlers = false;

  private readonly explicitSdk?: ScopeCallSDK;
  private readonly customerId: string | null;
  private readonly promptVersion: string | null;
  private readonly spans = new Map<string, TraceContext>();
  private readonly llm = new Map<string, { parent?: TraceContext; start: number }>();

  constructor(opts: HandlerOpts = {}) {
    this.explicitSdk = opts.sdk;
    this.customerId = opts.customerId ?? null;
    this.promptVersion = opts.promptVersion ?? null;
  }

  private sdk(): ScopeCallSDK | undefined {
    try {
      return this.explicitSdk ?? getActive();
    } catch {
      return undefined;
    }
  }

  private open(runId: string, parentRunId: string | undefined, name: string, kind: "agent" | "step") {
    const sdk = this.sdk();
    if (!sdk) return;
    try {
      const ctx = sdk.startSpan(name, {
        kind,
        parentContext: parentRunId ? this.spans.get(parentRunId) ?? null : null,
        customerId: this.customerId,
        promptVersion: this.promptVersion,
      });
      this.spans.set(runId, { ...ctx, start: Date.now() } as TraceContext & { start: number });
    } catch {
      /* never throw into LangChain */
    }
  }

  private close(runId: string, status: "success" | "error" = "success", errorMessage: string | null = null) {
    const sdk = this.sdk();
    const ctx = this.spans.get(runId) as (TraceContext & { start?: number }) | undefined;
    this.spans.delete(runId);
    if (!sdk || !ctx) return;
    try {
      sdk.endSpan(ctx, {
        latencyMs: ctx.start ? Date.now() - ctx.start : 0,
        status,
        errorMessage,
      });
    } catch {
      /* swallow */
    }
  }

  // ── chain → agent ──────────────────────────────────────────────────────
  handleChainStart(chain: unknown, _inputs: unknown, runId: string, parentRunId?: string, _tags?: unknown, _metadata?: unknown, _runType?: unknown, name?: string) {
    this.open(runId, parentRunId, name ?? serializedName(chain, "chain"), "agent");
  }
  handleChainEnd(_outputs: unknown, runId: string) { this.close(runId); }
  handleChainError(err: unknown, runId: string) { this.close(runId, "error", errMsg(err)); }

  // ── tool / retriever → step ──────────────────────────────────────────────
  handleToolStart(tool: unknown, _input: unknown, runId: string, parentRunId?: string, _tags?: unknown, _metadata?: unknown, name?: string) {
    this.open(runId, parentRunId, name ?? serializedName(tool, "tool"), "step");
  }
  handleToolEnd(_output: unknown, runId: string) { this.close(runId); }
  handleToolError(err: unknown, runId: string) { this.close(runId, "error", errMsg(err)); }

  handleRetrieverStart(retriever: unknown, _query: unknown, runId: string, parentRunId?: string) {
    this.open(runId, parentRunId, serializedName(retriever, "retriever"), "step");
  }
  handleRetrieverEnd(_docs: unknown, runId: string) { this.close(runId); }
  handleRetrieverError(err: unknown, runId: string) { this.close(runId, "error", errMsg(err)); }

  // ── llm → llm event ──────────────────────────────────────────────────────
  handleLLMStart(_llm: unknown, _prompts: unknown, runId: string, parentRunId?: string) {
    this.llm.set(runId, { parent: parentRunId ? this.spans.get(parentRunId) : undefined, start: Date.now() });
  }
  // chat models fire this variant
  handleChatModelStart(_llm: unknown, _messages: unknown, runId: string, parentRunId?: string) {
    this.llm.set(runId, { parent: parentRunId ? this.spans.get(parentRunId) : undefined, start: Date.now() });
  }

  handleLLMEnd(output: LLMResultish, runId: string) {
    const sdk = this.sdk();
    const entry = this.llm.get(runId);
    this.llm.delete(runId);
    if (!sdk) return;
    const { model, provider, inputTokens, outputTokens } = parseLLMResult(output);
    try {
      sdk.recordLlmCall({
        model,
        provider,
        inputTokens,
        outputTokens,
        latencyMs: entry ? Date.now() - entry.start : 0,
        status: "success",
        context: entry?.parent ?? null,
        customerId: this.customerId,
        promptVersion: this.promptVersion,
      });
    } catch {
      /* swallow */
    }
  }

  handleLLMError(err: unknown, runId: string) {
    const sdk = this.sdk();
    const entry = this.llm.get(runId);
    this.llm.delete(runId);
    if (!sdk) return;
    try {
      sdk.recordLlmCall({
        model: "unknown",
        provider: "unknown",
        latencyMs: entry ? Date.now() - entry.start : 0,
        status: "error",
        errorMessage: errMsg(err),
        context: entry?.parent ?? null,
        customerId: this.customerId,
        promptVersion: this.promptVersion,
      });
    } catch {
      /* swallow */
    }
  }
}

export function instrument(opts: HandlerOpts = {}): ScopeCallCallbackHandler {
  return new ScopeCallCallbackHandler(opts);
}

// ── helpers ────────────────────────────────────────────────────────────────

function serializedName(serialized: unknown, fallback: string): string {
  const s = serialized as { name?: string; id?: unknown } | undefined;
  if (s?.name) return s.name;
  if (Array.isArray(s?.id) && s!.id.length > 0) return String(s!.id[s!.id.length - 1]);
  return fallback;
}

function errMsg(err: unknown): string {
  const m = (err as { message?: string })?.message ?? String(err);
  return m.length > 1000 ? m.slice(0, 1000) : m;
}

function parseLLMResult(output: LLMResultish): {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
} {
  const model = output?.llmOutput?.model_name ?? output?.llmOutput?.model ?? "unknown";
  const usage = output?.llmOutput?.tokenUsage ?? output?.llmOutput?.estimatedTokenUsage;
  let inputTokens = usage?.promptTokens ?? 0;
  let outputTokens = usage?.completionTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) {
    const um = output?.generations?.[0]?.[0]?.message?.usage_metadata;
    if (um) {
      inputTokens = um.input_tokens ?? 0;
      outputTokens = um.output_tokens ?? 0;
    }
  }
  const m = model.toLowerCase();
  const provider = m.includes("gpt") || m.includes("o1") || m.includes("o3")
    ? "openai"
    : m.includes("claude")
      ? "anthropic"
      : m.includes("gemini")
        ? "google"
        : "unknown";
  return { model, provider, inputTokens, outputTokens };
}
