// prompt_version propagation: from trace() opts → context → instrumented
// LLM call's emitted LLMEvent.prompt_version. Tests the precedence chain:
//   trace() opts.promptVersion → parent's promptVersion → config.defaultPromptVersion → null

import { describe, it, expect, beforeEach, vi } from "vitest";
import { init, _resetInstance } from "../src/index.js";
import { trace } from "../src/context.js";
import { instrumentOpenAI } from "../src/instrumentation/openai.js";
import { instrumentAnthropic } from "../src/instrumentation/anthropic.js";
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

function openaiClient() {
  return {
    chat: {
      completions: {
        create: async () => ({
          id: "x", model: "gpt-4o",
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop" }],
        }),
      },
    },
  };
}

function anthropicClient() {
  return {
    messages: {
      create: async () => ({
        id: "x", type: "message", model: "claude-3-5-sonnet",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  };
}

beforeEach(() => {
  _resetInstance();
});

describe("prompt_version propagation", () => {
  it("opts.promptVersion on trace() flows to OpenAI events", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    await trace("billing-agent", async () => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
    }, { promptVersion: "v3.1" });

    expect(ex.events).toHaveLength(1);
    expect(ex.events[0]!.prompt_version).toBe("v3.1");
  });

  it("opts.promptVersion on trace() flows to Anthropic events", async () => {
    const ex = exporter();
    const client = anthropicClient();
    instrumentAnthropic(client, ex, {});

    await trace("billing-agent", async () => {
      await client.messages.create({ model: "claude-3-5-sonnet", max_tokens: 100, messages: [] });
    }, { promptVersion: "v3.1" });

    expect(ex.events).toHaveLength(1);
    expect(ex.events[0]!.prompt_version).toBe("v3.1");
  });

  it("falls back to config.defaultPromptVersion when no trace tag", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, { defaultPromptVersion: "release-2026.05.31" });

    // No trace() wrap, no opts — config default should apply.
    await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });

    expect(ex.events[0]!.prompt_version).toBe("release-2026.05.31");
  });

  it("trace-level promptVersion overrides config default", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, { defaultPromptVersion: "release-2026.05.31" });

    await trace("agent", async () => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
    }, { promptVersion: "experiment-A" });

    expect(ex.events[0]!.prompt_version).toBe("experiment-A");
  });

  it("nested trace inherits parent's promptVersion when not specified", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    await trace("outer", async () => {
      await trace("inner", async () => {
        await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
      });
    }, { promptVersion: "v2" });

    expect(ex.events[0]!.prompt_version).toBe("v2");
  });

  it("nested trace can override parent's promptVersion", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    await trace("outer", async () => {
      await trace("inner", async () => {
        await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
      }, { promptVersion: "v3-experimental" });
    }, { promptVersion: "v2" });

    expect(ex.events[0]!.prompt_version).toBe("v3-experimental");
  });

  it("nested trace can clear promptVersion by passing null", async () => {
    // Sentinel behaviour: explicit null on the inner trace removes the
    // inherited version. Documented contract; matches the "in" check in
    // context.ts trace() impl.
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    await trace("outer", async () => {
      await trace("inner", async () => {
        await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
      }, { promptVersion: null });
    }, { promptVersion: "v2" });

    expect(ex.events[0]!.prompt_version).toBeNull();
  });

  it("no tag anywhere → prompt_version=null on the wire", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
    expect(ex.events[0]!.prompt_version).toBeNull();
  });
});

// ─── parent_span_id wiring — Round-2 review P0 ──────────────────────────
// Without these, nested LLM calls don't appear under the trace span on
// the dashboard, breaking the workflow-debugger product story.
describe("parent_span_id wiring", () => {
  it("OpenAI call inside trace() emits parent_span_id = trace's spanId", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    let traceSpan: string | undefined;
    await trace("agent", async (ctx) => {
      traceSpan = ctx.spanId;
      await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
    });

    expect(ex.events).toHaveLength(1);
    expect(ex.events[0]!.parent_span_id).toBe(traceSpan);
  });

  it("Anthropic call inside trace() emits parent_span_id = trace's spanId", async () => {
    const ex = exporter();
    const client = anthropicClient();
    instrumentAnthropic(client, ex, {});

    let traceSpan: string | undefined;
    await trace("agent", async (ctx) => {
      traceSpan = ctx.spanId;
      await client.messages.create({ model: "claude-3-5-sonnet", max_tokens: 100, messages: [] });
    });

    expect(ex.events[0]!.parent_span_id).toBe(traceSpan);
  });

  it("multiple LLM calls in one trace share trace_id and parent_span_id", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    await trace("agent", async () => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
      await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
      await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
    });

    expect(ex.events).toHaveLength(3);
    const traceIds = new Set(ex.events.map((e) => e.trace_id));
    const parentIds = new Set(ex.events.map((e) => e.parent_span_id));
    const spanIds = new Set(ex.events.map((e) => e.span_id));
    expect(traceIds.size).toBe(1);    // same workflow
    expect(parentIds.size).toBe(1);   // all child of the same trace span
    expect(spanIds.size).toBe(3);     // each call gets its own span_id
  });

  it("nested traces produce a tree: inner LLM call → inner trace span → outer trace span", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    let outerSpan: string | undefined;
    let innerSpan: string | undefined;

    await trace("outer", async (outer) => {
      outerSpan = outer.spanId;
      await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
      await trace("inner", async (inner) => {
        innerSpan = inner.spanId;
        await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
      });
    });

    expect(ex.events).toHaveLength(2);
    const [outerCall, innerCall] = ex.events;
    // Both share the workflow trace_id
    expect(outerCall!.trace_id).toBe(innerCall!.trace_id);
    // Outer LLM call → child of outer trace span
    expect(outerCall!.parent_span_id).toBe(outerSpan);
    // Inner LLM call → child of inner trace span (which in turn parents to outer)
    expect(innerCall!.parent_span_id).toBe(innerSpan);
  });

  it("LLM call OUTSIDE any trace gets parent_span_id=null (single-span trace)", async () => {
    const ex = exporter();
    const client = openaiClient();
    instrumentOpenAI(client, ex, {});

    await client.chat.completions.create({ model: "gpt-4o", messages: [], stream: false });
    expect(ex.events[0]!.parent_span_id).toBeNull();
    // trace_id is synthesised to equal span_id for un-traced calls
    expect(ex.events[0]!.trace_id).toBe(ex.events[0]!.span_id);
  });
});
