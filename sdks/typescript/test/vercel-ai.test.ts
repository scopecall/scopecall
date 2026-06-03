// Vercel AI SDK bridge — verifies that wrapping a LanguageModelV1 model
// captures generateText (doGenerate) and streamText (doStream) paths.
//
// Duck-typed fake model — no peer dep on `ai` or `@ai-sdk/*`.

import { describe, it, expect, vi } from "vitest";
import { instrumentVercelAI } from "../src/instrumentation/vercel-ai.js";
import type { ScopeCallExporter } from "../src/exporter.js";
import type { LLMEvent } from "../src/wire/llm-event.js";

function exporter(): ScopeCallExporter & { events: LLMEvent[] } {
  const events: LLMEvent[] = [];
  return {
    events,
    enqueue: (e: LLMEvent) => { events.push(e); },
    flush: vi.fn(),
    close: vi.fn(),
  } as unknown as ScopeCallExporter & { events: LLMEvent[] };
}

// Build a duck-typed Vercel model. Mirrors the LanguageModelV1 shape from
// @ai-sdk/provider (provider, modelId, doGenerate, doStream).
function fakeModel(opts: {
  provider?: string;
  modelId?: string;
  generateResult?: Record<string, unknown>;
  generateError?: Error;
  streamParts?: Array<Record<string, unknown>>;
  streamError?: Error;
  streamSyncError?: Error;
  capturedOptions?: { generate?: Record<string, unknown> | null; stream?: Record<string, unknown> | null };
}) {
  const provider = opts.provider ?? "openai";
  const modelId = opts.modelId ?? "gpt-4o-2024-11-20";
  return {
    provider,
    modelId,
    sentinel: "preserved",
    async doGenerate(options: Record<string, unknown>) {
      if (opts.capturedOptions) opts.capturedOptions.generate = options;
      if (opts.generateError) throw opts.generateError;
      return (
        opts.generateResult ?? {
          text: "Default response",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 3 },
        }
      );
    },
    async doStream(options: Record<string, unknown>) {
      if (opts.capturedOptions) opts.capturedOptions.stream = options;
      if (opts.streamSyncError) throw opts.streamSyncError;
      const parts = opts.streamParts ?? [];
      const streamError = opts.streamError;
      const stream = new ReadableStream<Record<string, unknown>>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          if (streamError) {
            controller.error(streamError);
          } else {
            controller.close();
          }
        },
      });
      return { stream, rawCall: {}, rawResponse: {} };
    },
  };
}

async function drainStream<T>(s: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = s.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) out.push(value);
  }
  return out;
}

describe("Vercel AI SDK — non-streaming (doGenerate)", () => {
  it("emits one event with canonical model, tokens, finish_reason, text", async () => {
    const ex = exporter();
    const model = fakeModel({});
    instrumentVercelAI(model, ex, {});

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: "hello" }],
    });
    expect(result.text).toBe("Default response");

    expect(ex.events).toHaveLength(1);
    const ev = ex.events[0]!;
    // gpt-4o-2024-11-20 → gpt-4o via the pricing alias map
    expect(ev.model).toBe("gpt-4o");
    expect(ev.provider).toBe("openai");
    expect(ev.input_tokens).toBe(10);
    expect(ev.output_tokens).toBe(3);
    expect(ev.finish_reason).toBe("stop");
    expect(ev.output_text).toBe("Default response");
    expect(ev.status).toBe("success");
    expect(ev.ttft_ms).toBeNull();
    // Provider should reflect the model's own provider field, not a default.
    expect(ev.provider).toBe("openai");
  });

  it("uses the model's provider field for the event provider", async () => {
    const ex = exporter();
    const model = fakeModel({ provider: "anthropic", modelId: "claude-3-5-sonnet" });
    instrumentVercelAI(model, ex, {});
    await model.doGenerate({ prompt: [] });
    expect(ex.events[0]!.provider).toBe("anthropic");
  });

  it("folds block-array prompt content into input_text", async () => {
    const ex = exporter();
    const model = fakeModel({});
    instrumentVercelAI(model, ex, {});

    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are concise." },
        {
          role: "user",
          content: [
            { type: "text", text: "What is 2+2?" },
            { type: "image", image: "<binary>" }, // image parts are dropped
          ],
        },
      ],
    });
    const inputText = ex.events[0]!.input_text!;
    expect(inputText).toContain("system: You are concise.");
    expect(inputText).toContain("user: What is 2+2?");
    expect(inputText).not.toContain("binary");
  });

  it("captures tool_calls into the tool_calls JSON field", async () => {
    const ex = exporter();
    const model = fakeModel({
      generateResult: {
        text: "Calling weather tool",
        finishReason: "tool-calls",
        usage: { promptTokens: 5, completionTokens: 2 },
        toolCalls: [
          { toolName: "get_weather", args: { city: "Berlin" }, toolCallId: "call_1" },
        ],
      },
    });
    instrumentVercelAI(model, ex, {});

    await model.doGenerate({ prompt: [{ role: "user", content: "weather?" }] });
    expect(ex.events[0]!.tool_calls).not.toBeNull();
    const parsed = JSON.parse(ex.events[0]!.tool_calls!);
    expect(parsed[0].toolName).toBe("get_weather");
  });

  it("emits error event with rate_limited on 429 (statusCode)", async () => {
    const ex = exporter();
    const model = fakeModel({
      // Vercel SDK uses statusCode (not status) on APICallError instances.
      generateError: Object.assign(new Error("rate limited"), { statusCode: 429 }),
    });
    instrumentVercelAI(model, ex, {});

    await expect(model.doGenerate({ prompt: [] })).rejects.toThrow("rate limited");
    expect(ex.events).toHaveLength(1);
    expect(ex.events[0]!.status).toBe("rate_limited");
  });

  it("idempotent: double-instrument is a no-op", async () => {
    const ex = exporter();
    const model = fakeModel({});
    instrumentVercelAI(model, ex, {});
    instrumentVercelAI(model, ex, {});
    await model.doGenerate({ prompt: [] });
    expect(ex.events).toHaveLength(1);
  });

  it("logs warning and skips when object isn't a LanguageModel", async () => {
    const warn = vi.fn();
    const ex = exporter();
    // Missing modelId + doGenerate
    instrumentVercelAI({ provider: "openai" }, ex, { logger: { warn, error: vi.fn() } });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/LanguageModelV1/);
  });
});

describe("Vercel AI SDK — streaming (doStream)", () => {
  it("aggregates text-delta parts and captures finish part's usage", async () => {
    const ex = exporter();
    const model = fakeModel({
      streamParts: [
        { type: "text-delta", textDelta: "Hel" },
        { type: "text-delta", textDelta: "lo," },
        { type: "text-delta", textDelta: " world!" },
        { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 3 } },
      ],
    });
    instrumentVercelAI(model, ex, {});

    const result = await model.doStream({ prompt: [{ role: "user", content: "hi" }] });
    const parts = await drainStream(result.stream);
    expect(parts).toHaveLength(4);

    expect(ex.events).toHaveLength(1);
    const ev = ex.events[0]!;
    expect(ev.status).toBe("success");
    expect(ev.output_text).toBe("Hello, world!");
    expect(ev.finish_reason).toBe("stop");
    expect(ev.input_tokens).toBe(5);
    expect(ev.output_tokens).toBe(3);
    expect(ev.ttft_ms).not.toBeNull();
    expect(ev.ttft_ms!).toBeGreaterThanOrEqual(0);
  });

  it("records error status when a stream `error` part arrives", async () => {
    const ex = exporter();
    const model = fakeModel({
      streamParts: [
        { type: "text-delta", textDelta: "partial" },
        { type: "error", error: { message: "upstream blew up" } },
      ],
    });
    instrumentVercelAI(model, ex, {});

    const { stream } = await model.doStream({ prompt: [] });
    await drainStream(stream);
    expect(ex.events).toHaveLength(1);
    expect(ex.events[0]!.status).toBe("error");
    expect(ex.events[0]!.error_message).toContain("upstream blew up");
    expect(ex.events[0]!.output_text).toBe("partial");
  });

  it("emits one error event on synchronous doStream() failure", async () => {
    const ex = exporter();
    const model = fakeModel({
      streamSyncError: Object.assign(new Error("nope"), { statusCode: 429 }),
    });
    instrumentVercelAI(model, ex, {});

    await expect(model.doStream({ prompt: [] })).rejects.toThrow("nope");
    expect(ex.events).toHaveLength(1);
    expect(ex.events[0]!.status).toBe("rate_limited");
  });

  it("preserves the model's non-instrumented properties", async () => {
    // Our monkey-patch swaps doGenerate / doStream only — other fields like
    // .provider and .modelId (and our test sentinel) must round-trip.
    const ex = exporter();
    const model = fakeModel({});
    instrumentVercelAI(model, ex, {});
    expect((model as { sentinel: string }).sentinel).toBe("preserved");
    expect(model.provider).toBe("openai");
    expect(model.modelId).toBe("gpt-4o-2024-11-20");
  });

  it("captures tool-call parts during streaming", async () => {
    const ex = exporter();
    const model = fakeModel({
      streamParts: [
        { type: "tool-call", toolName: "search", toolCallId: "c1", args: { q: "hi" } },
        { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 5, completionTokens: 2 } },
      ],
    });
    instrumentVercelAI(model, ex, {});
    const { stream } = await model.doStream({ prompt: [] });
    await drainStream(stream);
    expect(ex.events[0]!.tool_calls).not.toBeNull();
    const calls = JSON.parse(ex.events[0]!.tool_calls!);
    expect(calls[0].toolName).toBe("search");
  });
});
