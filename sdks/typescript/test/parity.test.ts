import { describe, it, expect, beforeEach } from "vitest";
import { init, getActive, captureContext, _resetInstance, trace } from "../src/index.js";
import type { TraceContext } from "../src/context.js";

describe("universal-instrumentation parity primitives", () => {
  beforeEach(() => _resetInstance());

  it("getActive() returns the initialized instance (undefined before init)", () => {
    expect(getActive()).toBeUndefined();
    const sdk = init({ debug: true });
    expect(getActive()).toBe(sdk);
  });

  it("captureContext() returns the active context inside a trace, undefined outside", async () => {
    init({ debug: true });
    expect(captureContext()).toBeUndefined();
    let captured: TraceContext | undefined;
    await trace("wf", async () => {
      captured = captureContext();
    });
    expect(captured).toBeDefined();
    expect(captured!.name).toBe("wf");
  });

  it("parentContext explicitly parents a span across async boundaries", async () => {
    init({ debug: true });
    let parent: TraceContext | undefined;
    await trace("workflow", async (ctx) => {
      parent = ctx;
    });
    // Outside the workflow's async scope now — ambient store is empty.
    expect(captureContext()).toBeUndefined();
    let childParentId: string | null = null;
    let childTraceId = "";
    await trace(
      "agent",
      async (ctx) => {
        childParentId = ctx.parentSpanId;
        childTraceId = ctx.traceId;
      },
      { parentContext: parent, kind: "agent" },
    );
    expect(childParentId).toBe(parent!.spanId);
    expect(childTraceId).toBe(parent!.traceId);
  });
});
