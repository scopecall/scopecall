import { describe, it, expect, beforeEach } from "vitest";
import { init, _resetInstance, type ScopeCallSDK } from "../src/index.js";
import { ScopeCallCallbackHandler } from "../src/integrations/langchain.js";
import type { LLMEvent } from "../src/wire/llm-event.js";

// Capture emitted events by stubbing the transport. init({ debug:true })
// uses the console transport; we wrap the SDK's flush path by intercepting
// via a custom transport.
function makeSdk(): { sdk: ScopeCallSDK; events: LLMEvent[] } {
  const events: LLMEvent[] = [];
  const sdk = init({
    transport: {
      send: async (req) => {
        events.push(...req.events);
        return { ok: true, status: 200 };
      },
    },
    flushIntervalMs: 0,
  });
  return { sdk, events };
}

describe("manual span API + LangChain handler", () => {
  beforeEach(() => _resetInstance());

  it("startSpan / endSpan / recordLlmCall emit linked events", async () => {
    const { sdk, events } = makeSdk();
    const agent = sdk.startSpan("router", { kind: "agent", customerId: "c1" });
    sdk.recordLlmCall({ model: "gpt-4o", provider: "openai", inputTokens: 10, outputTokens: 5, latencyMs: 100, context: agent });
    sdk.endSpan(agent, { latencyMs: 200 });
    await sdk.flush();

    const llm = events.find((e) => e.kind === "llm")!;
    const ag = events.find((e) => e.kind === "agent")!;
    expect(ag.feature_name).toBe("router");
    expect(ag.customer_id).toBe("c1");
    expect(llm.parent_span_id).toBe(agent.spanId);
    expect(llm.customer_id).toBe("c1");
    expect(llm.input_tokens).toBe(10);
  });

  it("LangChain handler nests chain → tool → llm", async () => {
    const { sdk, events } = makeSdk();
    const h = new ScopeCallCallbackHandler({ sdk, customerId: "acme" });
    h.handleChainStart({ name: "router" }, {}, "chain1");
    h.handleToolStart({ name: "search" }, "q", "tool1", "chain1");
    h.handleLLMStart({}, ["p"], "llm1", "tool1");
    h.handleLLMEnd(
      { llmOutput: { model_name: "gpt-4o-mini", tokenUsage: { promptTokens: 12, completionTokens: 4 } } },
      "llm1",
    );
    h.handleToolEnd("done", "tool1");
    h.handleChainEnd({}, "chain1");
    await sdk.flush();

    const agent = events.find((e) => e.kind === "agent")!;
    const step = events.find((e) => e.kind === "step")!;
    const llm = events.find((e) => e.kind === "llm")!;
    expect(agent.feature_name).toBe("router");
    expect(step.feature_name).toBe("search");
    expect(step.parent_span_id).toBe(agent.span_id);
    expect(llm.parent_span_id).toBe(step.span_id);
    expect(llm.input_tokens).toBe(12);
    expect(llm.output_tokens).toBe(4);
    expect(llm.provider).toBe("openai");
    expect(llm.customer_id).toBe("acme");
  });

  it("is a no-op when ScopeCall is disabled (no init)", async () => {
    const h = new ScopeCallCallbackHandler();
    // Should not throw even though no SDK is active.
    expect(() => {
      h.handleChainStart({ name: "x" }, {}, "r1");
      h.handleChainEnd({}, "r1");
    }).not.toThrow();
  });
});
