// Anthropic instrumentation — covers both non-streaming and streaming
// messages.create. Parallel to test/openai-streaming.test.ts.
//
// Duck-typed fake client — no peer dep on @anthropic-ai/sdk.

import { describe, it, expect, vi } from "vitest";
import { instrumentAnthropic } from "../src/instrumentation/anthropic.js";
import type { ScopeCallExporter } from "../src/exporter.js";
import type { LLMEvent } from "../src/wire/llm-event.js";

type AnthEvent = Record<string, unknown>;

function fakeExporter(): ScopeCallExporter & { events: LLMEvent[] } {
  const events: LLMEvent[] = [];
  return {
    events,
    enqueue: (e: LLMEvent) => { events.push(e); },
    flush: vi.fn(),
    close: vi.fn(),
  } as unknown as ScopeCallExporter & { events: LLMEvent[] };
}

function nonStreamingClient(opts: {
  response?: Record<string, unknown>;
  syncError?: Error;
}) {
  return {
    messages: {
      create: async function (_params: Record<string, unknown>) {
        if (opts.syncError) throw opts.syncError;
        return (
          opts.response ?? {
            id: "msg_xyz",
            type: "message",
            model: "claude-3-5-sonnet-20241022",
            content: [{ type: "text", text: "Hello back" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 12, output_tokens: 5 },
          }
        );
      },
    },
  };
}

function streamingClient(opts: {
  events: AnthEvent[];
  throwAfter?: number;
  syncError?: Error;
  capturedParams?: { current: Record<string, unknown> | null };
}) {
  return {
    messages: {
      create: async function (params: Record<string, unknown>) {
        if (opts.capturedParams) opts.capturedParams.current = params;
        if (opts.syncError) throw opts.syncError;
        const events = opts.events;
        const throwAfter = opts.throwAfter;
        const stream: AsyncIterable<AnthEvent> & { sentinel: string } = {
          sentinel: "preserved",
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next(): Promise<IteratorResult<AnthEvent>> {
                if (throwAfter !== undefined && i >= throwAfter) {
                  throw new Error("anthropic stream broke");
                }
                if (i >= events.length) return { value: undefined, done: true };
                return { value: events[i++]!, done: false };
              },
            };
          },
        };
        return stream;
      },
    },
  };
}

describe("Anthropic non-streaming instrumentation", () => {
  it("emits one event with model, tokens, stop_reason, content", async () => {
    const client = nonStreamingClient({});
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(exporter.events).toHaveLength(1);
    const ev = exporter.events[0]!;
    expect(ev.provider).toBe("anthropic");
    expect(ev.status).toBe("success");
    // Versioned model resolves to canonical via SDK pricing aliases
    expect(ev.model).toBe("claude-3-5-sonnet");
    expect(ev.input_tokens).toBe(12);
    expect(ev.output_tokens).toBe(5);
    expect(ev.finish_reason).toBe("end_turn");
    expect(ev.output_text).toBe("Hello back");
    expect(ev.ttft_ms).toBeNull();
  });

  it("folds string content + block-array content into input_text", async () => {
    const client = nonStreamingClient({});
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    await client.messages.create({
      model: "claude-3-5-sonnet",
      max_tokens: 100,
      system: "You are concise.",
      messages: [
        { role: "user", content: "what is 2+2?" },
        // Block array form — uncommon but valid
        { role: "assistant", content: [{ type: "text", text: "4" }] },
        { role: "user", content: "are you sure?" },
      ],
    });

    const inputText = exporter.events[0]!.input_text!;
    expect(inputText).toContain("system: You are concise.");
    expect(inputText).toContain("user: what is 2+2?");
    expect(inputText).toContain("assistant: 4");
    expect(inputText).toContain("user: are you sure?");
  });

  it("captures cache_read_input_tokens", async () => {
    const client = nonStreamingClient({
      response: {
        id: "msg_x",
        type: "message",
        model: "claude-3-5-sonnet",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_read_input_tokens: 80,
        },
      },
    });
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    await client.messages.create({
      model: "claude-3-5-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(exporter.events[0]!.cache_read_tokens).toBe(80);
  });

  it("emits error event with rate_limited status on 429", async () => {
    const client = nonStreamingClient({
      syncError: Object.assign(new Error("too many"), { status: 429 }),
    });
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    await expect(
      client.messages.create({
        model: "claude-3-5-sonnet",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("too many");

    expect(exporter.events).toHaveLength(1);
    expect(exporter.events[0]!.status).toBe("rate_limited");
  });

  it("idempotent: calling instrumentAnthropic twice on same client only patches once", async () => {
    const client = nonStreamingClient({});
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});
    instrumentAnthropic(client, exporter, {});

    await client.messages.create({
      model: "claude-3-5-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    // If the second instrumentation had taken effect, we'd see 2 events.
    expect(exporter.events).toHaveLength(1);
  });

  it("logs warning and no-ops for a non-Anthropic-shaped client", async () => {
    const warn = vi.fn();
    const exporter = fakeExporter();
    // No `messages` property — duck-type check should fail
    const badClient = { chat: { completions: { create: async () => ({}) } } };
    instrumentAnthropic(badClient, exporter, { logger: { warn, error: vi.fn() } });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/messages\.create/);
  });
});

describe("Anthropic streaming instrumentation", () => {
  it("aggregates content_block_delta text, captures stop_reason + final usage", async () => {
    const client = streamingClient({
      events: [
        { type: "message_start", message: { model: "claude-3-5-sonnet", usage: { input_tokens: 8, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The answer " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "is 42." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
        { type: "message_stop" },
      ],
    });
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    const stream = await client.messages.create({
      model: "claude-3-5-sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "what?" }],
      stream: true,
    });

    const chunks: AnthEvent[] = [];
    for await (const ev of stream as AsyncIterable<AnthEvent>) chunks.push(ev);
    expect(chunks).toHaveLength(7);

    expect(exporter.events).toHaveLength(1);
    const ev = exporter.events[0]!;
    expect(ev.status).toBe("success");
    expect(ev.output_text).toBe("The answer is 42.");
    expect(ev.finish_reason).toBe("end_turn");
    // input_tokens from message_start, output_tokens from message_delta
    // (NOT the placeholder 1 from message_start)
    expect(ev.input_tokens).toBe(8);
    expect(ev.output_tokens).toBe(6);
    expect(ev.ttft_ms).not.toBeNull();
    expect(ev.ttft_ms!).toBeGreaterThanOrEqual(0);
  });

  it("ignores ping events and message_start output_tokens placeholder", async () => {
    // Anthropic sends `ping` keepalives intermittently. They must not be
    // mistaken for content. And output_tokens=1 from message_start is a
    // placeholder we explicitly don't trust — the real value comes from
    // message_delta.
    const client = streamingClient({
      events: [
        { type: "message_start", message: { model: "claude-3-5-sonnet", usage: { input_tokens: 100, output_tokens: 1 } } },
        { type: "ping" },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
        { type: "ping" },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 50 } },
        { type: "message_stop" },
      ],
    });
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    const stream = await client.messages.create({
      model: "claude-3-5-sonnet", max_tokens: 50, messages: [],
      stream: true,
    });
    for await (const _ of stream as AsyncIterable<AnthEvent>) { /* drain */ }

    expect(exporter.events[0]!.output_text).toBe("x");
    expect(exporter.events[0]!.output_tokens).toBe(50);
    expect(exporter.events[0]!.finish_reason).toBe("max_tokens");
  });

  it("emits one event when consumer breaks early — partial data preserved", async () => {
    const client = streamingClient({
      events: [
        { type: "message_start", message: { model: "claude-3-5-sonnet", usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second" } },
      ],
    });
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    const stream = await client.messages.create({
      model: "claude-3-5-sonnet", max_tokens: 100, messages: [],
      stream: true,
    });
    for await (const ev of stream as AsyncIterable<AnthEvent>) {
      if (ev.type === "content_block_delta") break;
    }

    expect(exporter.events).toHaveLength(1);
    expect(exporter.events[0]!.output_text).toBe("first");
    expect(exporter.events[0]!.input_tokens).toBe(5);
    expect(exporter.events[0]!.status).toBe("success");
  });

  it("emits one error event on mid-stream failure with partial state", async () => {
    const client = streamingClient({
      events: [
        { type: "message_start", message: { model: "claude-3-5-sonnet", usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "before-break" } },
      ],
      throwAfter: 3,
    });
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    const stream = await client.messages.create({
      model: "claude-3-5-sonnet", max_tokens: 100, messages: [],
      stream: true,
    });

    await expect(async () => {
      for await (const _ of stream as AsyncIterable<AnthEvent>) { /* drain */ }
    }).rejects.toThrow("anthropic stream broke");

    expect(exporter.events).toHaveLength(1);
    expect(exporter.events[0]!.status).toBe("error");
    expect(exporter.events[0]!.output_text).toBe("partial before-break");
    expect(exporter.events[0]!.ttft_ms).not.toBeNull();
  });

  it("emits one error event on synchronous create() failure", async () => {
    const client = streamingClient({
      events: [],
      syncError: Object.assign(new Error("rate limited"), { status: 429 }),
    });
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    await expect(
      client.messages.create({
        model: "claude-3-5-sonnet", max_tokens: 100, messages: [],
        stream: true,
      }),
    ).rejects.toThrow("rate limited");

    expect(exporter.events).toHaveLength(1);
    expect(exporter.events[0]!.status).toBe("rate_limited");
    expect(exporter.events[0]!.ttft_ms).toBeNull();
  });

  it("preserves non-iterator properties on the wrapped stream", async () => {
    const client = streamingClient({ events: [] });
    const exporter = fakeExporter();
    instrumentAnthropic(client, exporter, {});

    const stream = (await client.messages.create({
      model: "claude-3-5-sonnet", max_tokens: 100, messages: [],
      stream: true,
    })) as unknown as { sentinel: string };

    expect(stream.sentinel).toBe("preserved");
    for await (const _ of stream as unknown as AsyncIterable<AnthEvent>) { /* drain */ }
  });
});
