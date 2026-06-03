// Streaming OpenAI instrumentation — verifies:
//   - TTFT is captured on the first chunk
//   - aggregated content makes it into output_text
//   - finish_reason from the last chunk surfaces
//   - usage from include_usage chunk populates tokens
//   - stream_options.include_usage is injected when absent
//   - explicit include_usage:false is honored
//   - early `break` from the consumer still emits the event
//   - sync (pre-iteration) errors emit a single error event
//   - mid-stream errors emit one event with status="error"
//
// We don't mock the OpenAI package — instead we hand the instrumenter a
// duck-typed object that looks like the real client. Same shape, no peer dep.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { instrumentOpenAI } from "../src/instrumentation/openai.js";
import type { ScopeCallExporter } from "../src/exporter.js";
import type { LLMEvent } from "../src/wire/llm-event.js";

interface FakeChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; role?: string };
    finish_reason?: string | null;
    index?: number;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** Builds a duck-typed OpenAI client whose chat.completions.create returns
 *  an async iterable that yields the given chunks in sequence. The iterable
 *  also carries extra properties to verify our Symbol.asyncIterator swap
 *  doesn't clobber them (parity with real openai.Stream). */
function fakeClient(opts: {
  chunks: FakeChunk[];
  /** Optional: throw mid-stream after yielding this many chunks. */
  throwAfter?: number;
  /** Optional: throw synchronously from create() instead of returning a stream. */
  syncError?: Error;
  /** Captured params passed to create() — for asserting on injected options. */
  capturedParams?: { current: Record<string, unknown> | null };
}) {
  return {
    chat: {
      completions: {
        create: async function (params: Record<string, unknown>) {
          if (opts.capturedParams) opts.capturedParams.current = params;
          if (opts.syncError) throw opts.syncError;
          const chunks = opts.chunks;
          const throwAfter = opts.throwAfter;
          // The real openai.Stream has .controller, .toReadableStream(), etc.
          // We attach a sentinel property to verify our wrapper preserves it.
          const stream: AsyncIterable<FakeChunk> & { sentinel: string } = {
            sentinel: "preserved",
            [Symbol.asyncIterator]() {
              let i = 0;
              return {
                async next(): Promise<IteratorResult<FakeChunk>> {
                  if (throwAfter !== undefined && i >= throwAfter) {
                    throw new Error("stream broke mid-flight");
                  }
                  if (i >= chunks.length) return { value: undefined, done: true };
                  return { value: chunks[i++]!, done: false };
                },
              };
            },
          };
          return stream;
        },
      },
    },
  };
}

function fakeExporter(): ScopeCallExporter & { events: LLMEvent[] } {
  const events: LLMEvent[] = [];
  return {
    events,
    enqueue: (e: LLMEvent) => { events.push(e); },
    flush: vi.fn(),
    close: vi.fn(),
  } as unknown as ScopeCallExporter & { events: LLMEvent[] };
}

describe("OpenAI streaming instrumentation", () => {
  beforeEach(() => {
    vi.useRealTimers(); // we measure real time deltas
  });

  it("emits one event with TTFT, aggregated content, finish_reason, and usage", async () => {
    const client = fakeClient({
      chunks: [
        { model: "gpt-4o-2024-11-20", choices: [{ delta: { role: "assistant" } }] },
        { choices: [{ delta: { content: "Hello, " } }] },
        { choices: [{ delta: { content: "world!" } }] },
        { choices: [{ finish_reason: "stop" }] },
        { usage: { prompt_tokens: 10, completion_tokens: 3 } },
      ],
    });
    const exporter = fakeExporter();
    instrumentOpenAI(client, exporter, {});

    const stream = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    const seen: string[] = [];
    for await (const chunk of stream as AsyncIterable<FakeChunk>) {
      const c = chunk.choices?.[0]?.delta?.content;
      if (c) seen.push(c);
    }
    expect(seen.join("")).toBe("Hello, world!");

    expect(exporter.events).toHaveLength(1);
    const ev = exporter.events[0]!;
    expect(ev.status).toBe("success");
    expect(ev.ttft_ms).not.toBeNull();
    expect(ev.ttft_ms!).toBeGreaterThanOrEqual(0);
    expect(ev.output_text).toBe("Hello, world!");
    expect(ev.finish_reason).toBe("stop");
    expect(ev.input_tokens).toBe(10);
    expect(ev.output_tokens).toBe(3);
    // Model canonicalisation: versioned ID resolves to canonical via SDK pricing table
    expect(ev.model).toBe("gpt-4o");
  });

  it("auto-injects stream_options.include_usage when absent", async () => {
    const captured = { current: null as Record<string, unknown> | null };
    const client = fakeClient({ chunks: [], capturedParams: captured });
    const exporter = fakeExporter();
    instrumentOpenAI(client, exporter, {});

    const stream = await client.chat.completions.create({
      model: "gpt-4o", messages: [], stream: true,
    });
    // Drain so the finally runs (event is emitted on iteration completion).
    for await (const _ of stream as AsyncIterable<FakeChunk>) { /* noop */ }

    expect(captured.current?.stream_options).toEqual({ include_usage: true });
  });

  it("respects explicit include_usage:false", async () => {
    const captured = { current: null as Record<string, unknown> | null };
    const client = fakeClient({ chunks: [], capturedParams: captured });
    const exporter = fakeExporter();
    instrumentOpenAI(client, exporter, {});

    const stream = await client.chat.completions.create({
      model: "gpt-4o", messages: [], stream: true,
      stream_options: { include_usage: false },
    });
    for await (const _ of stream as AsyncIterable<FakeChunk>) { /* noop */ }

    expect(captured.current?.stream_options).toEqual({ include_usage: false });
  });

  it("fills in include_usage when stream_options exists but flag is undefined", async () => {
    // E.g. user set { stream_options: { otherOption: 1 } } — we should add
    // include_usage without clobbering the rest.
    const captured = { current: null as Record<string, unknown> | null };
    const client = fakeClient({ chunks: [], capturedParams: captured });
    const exporter = fakeExporter();
    instrumentOpenAI(client, exporter, {});

    const stream = await client.chat.completions.create({
      model: "gpt-4o", messages: [], stream: true,
      stream_options: { someOtherOption: "x" } as Record<string, unknown>,
    });
    for await (const _ of stream as AsyncIterable<FakeChunk>) { /* noop */ }

    expect(captured.current?.stream_options).toEqual({
      someOtherOption: "x",
      include_usage: true,
    });
  });

  it("emits event when consumer breaks out of the loop early", async () => {
    // The async generator's finally block must run on iterator.return(),
    // which happens when the consumer breaks. Otherwise observability is
    // silently lost for every aborted stream — common in agentic apps that
    // bail on the first chunk that satisfies a condition.
    const client = fakeClient({
      chunks: [
        { choices: [{ delta: { content: "a" } }] },
        { choices: [{ delta: { content: "b" } }] },
        { choices: [{ delta: { content: "c" } }] },
      ],
    });
    const exporter = fakeExporter();
    instrumentOpenAI(client, exporter, {});

    const stream = await client.chat.completions.create({
      model: "gpt-4o", messages: [], stream: true,
    });
    for await (const chunk of stream as AsyncIterable<FakeChunk>) {
      if (chunk.choices?.[0]?.delta?.content === "a") break;
    }
    expect(exporter.events).toHaveLength(1);
    // Partial content captured (only the first chunk's content)
    expect(exporter.events[0]!.output_text).toBe("a");
    expect(exporter.events[0]!.status).toBe("success");
  });

  it("emits one error event on synchronous create() failure", async () => {
    // 429 before any iteration: there's no stream object to wait on.
    const client = fakeClient({
      chunks: [],
      syncError: Object.assign(new Error("rate limited"), { status: 429 }),
    });
    const exporter = fakeExporter();
    instrumentOpenAI(client, exporter, {});

    await expect(
      client.chat.completions.create({ model: "gpt-4o", messages: [], stream: true })
    ).rejects.toThrow("rate limited");

    expect(exporter.events).toHaveLength(1);
    expect(exporter.events[0]!.status).toBe("rate_limited");
    expect(exporter.events[0]!.ttft_ms).toBeNull();
  });

  it("emits one error event on mid-stream failure", async () => {
    // Stream broke after 2 chunks. We should see status=error and the
    // captured partial content/TTFT, not zero data.
    const client = fakeClient({
      chunks: [
        { choices: [{ delta: { content: "partial-" } }] },
        { choices: [{ delta: { content: "data" } }] },
      ],
      throwAfter: 2,
    });
    const exporter = fakeExporter();
    instrumentOpenAI(client, exporter, {});

    const stream = await client.chat.completions.create({
      model: "gpt-4o", messages: [], stream: true,
    });

    await expect(async () => {
      for await (const _ of stream as AsyncIterable<FakeChunk>) { /* noop */ }
    }).rejects.toThrow("stream broke mid-flight");

    expect(exporter.events).toHaveLength(1);
    const ev = exporter.events[0]!;
    expect(ev.status).toBe("error");
    expect(ev.error_message).toContain("stream broke");
    expect(ev.output_text).toBe("partial-data");
    expect(ev.ttft_ms).not.toBeNull();
  });

  it("preserves non-iterator properties on the wrapped stream", async () => {
    // We replace ONLY Symbol.asyncIterator. The real openai.Stream has
    // .controller, .toReadableStream(), .tee() — users rely on those.
    // Our fake exposes a `sentinel` property; verify it survives.
    const client = fakeClient({ chunks: [] });
    const exporter = fakeExporter();
    instrumentOpenAI(client, exporter, {});

    const stream = (await client.chat.completions.create({
      model: "gpt-4o", messages: [], stream: true,
    })) as unknown as { sentinel: string };

    expect(stream.sentinel).toBe("preserved");

    // Drain to fire the finally.
    for await (const _ of stream as unknown as AsyncIterable<FakeChunk>) { /* noop */ }
  });

  it("non-streaming path still works (regression guard)", async () => {
    // Ensure we didn't break the non-streaming code path while adding the
    // streaming branch above it.
    const nonStreamingClient = {
      chat: {
        completions: {
          create: async function (_params: Record<string, unknown>) {
            return {
              id: "x",
              model: "gpt-4o",
              usage: { prompt_tokens: 5, completion_tokens: 7 },
              choices: [{ message: { content: "hi", role: "assistant" }, finish_reason: "stop" }],
            };
          },
        },
      },
    };
    const exporter = fakeExporter();
    instrumentOpenAI(nonStreamingClient, exporter, {});

    await nonStreamingClient.chat.completions.create({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }],
    });

    expect(exporter.events).toHaveLength(1);
    expect(exporter.events[0]!.ttft_ms).toBeNull();
    expect(exporter.events[0]!.output_text).toBe("hi");
    expect(exporter.events[0]!.input_tokens).toBe(5);
    expect(exporter.events[0]!.output_tokens).toBe(7);
  });
});
