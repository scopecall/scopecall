// V5.7  trace() returns callback value, emits one event
// V5.8  nested trace() creates parent-child context
// V5.9  sync throw inside trace() → rejected promise (not sync throw)

import { describe, it, expect, beforeEach } from "vitest";
import { init, _resetInstance } from "../src/index.js";
import { storage } from "../src/context.js";
import type { Transport } from "../src/transport/types.js";
import type { ExportRequest, ExportResponse } from "../src/transport/types.js";
import type { LLMEvent } from "../src/wire/llm-event.js";

function collectingTransport(): Transport & { events: LLMEvent[] } {
  const events: LLMEvent[] = [];
  return {
    events,
    async send(req: ExportRequest): Promise<ExportResponse> {
      events.push(...req.events);
      return { ok: true, status: 200 };
    },
  };
}

beforeEach(() => {
  _resetInstance();
});

describe("trace()", () => {
  it("V5.7 — returns the callback return value", async () => {
    const sdk = init({ transport: collectingTransport() });
    const result = await sdk.trace("my-feature", async () => 42);
    expect(result).toBe(42);
  });

  it("stores traceId and spanId in AsyncLocalStorage context", async () => {
    const sdk = init({ transport: collectingTransport() });
    let capturedCtx: ReturnType<typeof storage.getStore> | undefined;

    await sdk.trace("ctx-test", async (ctx) => {
      capturedCtx = storage.getStore();
      expect(ctx.traceId).toBeTruthy();
      expect(ctx.spanId).toBeTruthy();
      expect(ctx.name).toBe("ctx-test");
    });

    expect(capturedCtx).toBeDefined();
  });

  it("V5.8 — nested trace() propagates parentSpanId via ALS context", async () => {
    const sdk = init({ transport: collectingTransport() });

    let outerSpanId: string | undefined;
    let innerParentSpanId: string | null | undefined;

    await sdk.trace("outer", async (outerCtx) => {
      outerSpanId = outerCtx.spanId;

      await sdk.trace("inner", async (innerCtx) => {
        innerParentSpanId = innerCtx.parentSpanId;
      });
    });

    // parentSpanId on the TraceContext (internal) = outer's spanId
    expect(innerParentSpanId).toBe(outerSpanId);
  });

  it("V5.9 — sync throw inside trace() becomes a rejected promise (does NOT throw sync)", () => {
    const sdk = init({ transport: collectingTransport() });

    // If this threw synchronously, calling .catch() on it would fail
    const promise = sdk.trace("sync-throw", () => {
      throw new Error("boom");
    });

    // Must be a Promise (not a thrown exception at call site)
    expect(promise).toBeInstanceOf(Promise);
    return expect(promise).rejects.toThrow("boom");
  });

  it("nested traces INHERIT the outer traceId so the workflow groups together", async () => {
    // Round-2 review fix: previously every nested trace() got a fresh
    // traceId, splitting workflows into disconnected spans on the
    // dashboard. Now nested calls inherit the outer trace's id.
    const sdk = init({ transport: collectingTransport() });

    let outerTraceId: string | undefined;
    let innerTraceId: string | undefined;

    await sdk.trace("outer", async (outerCtx) => {
      outerTraceId = outerCtx.traceId;
      await sdk.trace("inner", async (innerCtx) => {
        innerTraceId = innerCtx.traceId;
      });
    });

    expect(outerTraceId).toBeDefined();
    expect(innerTraceId).toBeDefined();
    expect(innerTraceId).toBe(outerTraceId);
  });

  it("deeply nested traces all share the same traceId", async () => {
    const sdk = init({ transport: collectingTransport() });
    const ids: string[] = [];
    await sdk.trace("a", async (a) => {
      ids.push(a.traceId);
      await sdk.trace("b", async (b) => {
        ids.push(b.traceId);
        await sdk.trace("c", async (c) => {
          ids.push(c.traceId);
        });
      });
    });
    expect(new Set(ids).size).toBe(1);
  });

  // ─── workflow-span persistence — Round-3 review P0 ───────────────────
  // sdk.trace() must emit one synthetic event per block so the trace
  // tree's JOIN finds a real parent row for child LLM calls. Without
  // these, the dashboard's "workflow node" was virtual.
  it("sdk.trace() emits exactly one workflow-span event on success", async () => {
    const t = collectingTransport();
    const sdk = init({ transport: t });
    let traceSpan: string | undefined;
    let traceId: string | undefined;
    await sdk.trace("billing-agent", async (ctx) => {
      traceSpan = ctx.spanId;
      traceId = ctx.traceId;
    });
    // ScopeCallExporter batches; manual flush so the transport sees the event.
    await sdk.flush();
    // Exactly one event (no LLM calls inside this block)
    expect(t.events).toHaveLength(1);
    const ev = t.events[0]!;
    expect(ev.kind).toBe("workflow");
    expect(ev.span_id).toBe(traceSpan);
    expect(ev.trace_id).toBe(traceId);
    expect(ev.feature_name).toBe("billing-agent");
    expect(ev.status).toBe("success");
    expect(ev.model).toBe("");
    expect(ev.provider).toBe("");
    expect(ev.input_tokens).toBe(0);
    expect(ev.output_tokens).toBe(0);
    expect(ev.cost_usd).toBe(0);
  });

  it("workflow-span event has status=error when the block throws", async () => {
    const t = collectingTransport();
    const sdk = init({ transport: t });
    await expect(sdk.trace("doomed", async () => {
      throw Object.assign(new Error("boom"), { status: 500 });
    })).rejects.toThrow("boom");
    await sdk.flush();
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.kind).toBe("workflow");
    expect(t.events[0]!.status).toBe("error");
    expect(t.events[0]!.error_message).toContain("boom");
  });

  it("workflow-span 429 → status=rate_limited", async () => {
    const t = collectingTransport();
    const sdk = init({ transport: t });
    await expect(sdk.trace("throttled", async () => {
      throw Object.assign(new Error("nope"), { status: 429 });
    })).rejects.toThrow("nope");
    await sdk.flush();
    expect(t.events[0]!.status).toBe("rate_limited");
  });

  it("nested traces emit TWO workflow events with correct parent_span_id wiring", async () => {
    const t = collectingTransport();
    const sdk = init({ transport: t });
    let outerSpan: string | undefined;
    let innerSpan: string | undefined;
    await sdk.trace("outer", async (outer) => {
      outerSpan = outer.spanId;
      await sdk.trace("inner", async (inner) => {
        innerSpan = inner.spanId;
      });
    });
    await sdk.flush();
    // Events arrive in inner-finishes-first order (LIFO via the finally
    // blocks unwinding). Sort by name to make assertions order-independent.
    expect(t.events).toHaveLength(2);
    const byName = Object.fromEntries(t.events.map((e) => [e.feature_name, e]));
    expect(byName["outer"]!.parent_span_id).toBeNull();
    expect(byName["inner"]!.parent_span_id).toBe(outerSpan);
    expect(byName["inner"]!.span_id).toBe(innerSpan);
    // Both share the workflow trace_id
    expect(byName["outer"]!.trace_id).toBe(byName["inner"]!.trace_id);
  });

  it("each nested trace's parentSpanId points at the immediately enclosing trace's spanId", async () => {
    const sdk = init({ transport: collectingTransport() });
    let outerSpan: string | undefined;
    let midSpan: string | undefined;
    let midParent: string | null | undefined;
    let leafParent: string | null | undefined;

    await sdk.trace("outer", async (outer) => {
      outerSpan = outer.spanId;
      await sdk.trace("mid", async (mid) => {
        midSpan = mid.spanId;
        midParent = mid.parentSpanId;
        await sdk.trace("leaf", async (leaf) => {
          leafParent = leaf.parentSpanId;
        });
      });
    });

    expect(midParent).toBe(outerSpan);
    expect(leafParent).toBe(midSpan);
  });
});
