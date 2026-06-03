/**
 * V5.16 — Real OpenAI integration test.
 *
 * Requires:
 *   OPENAI_API_KEY     — OpenAI API key with chat.completions access
 *   SCOPECALL_API_KEY  — ScopeCall ingest API key (for HttpTransport)
 *
 * Run with:
 *   OPENAI_API_KEY=sk-... SCOPECALL_API_KEY=sc-... pnpm test
 *
 * Contract (V5.16): After one real chat.completions call + flush(),
 *   the captured event must have input_tokens > 0 and cost_usd > 0.
 *   This verifies end-to-end: OpenAI instrumentation → event capture →
 *   alias resolution (versioned model ID → canonical) → cost calculation.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { init, _resetInstance } from "../src/index.js";
import type { LLMEvent } from "../src/wire/llm-event.js";
import type { Transport } from "../src/transport/types.js";
import type { ExportRequest, ExportResponse } from "../src/transport/types.js";

const haveKeys =
  !!process.env.OPENAI_API_KEY && !!process.env.SCOPECALL_API_KEY;

// Skip entire suite when credentials are absent — zero noise in CI
const integrationDescribe = haveKeys ? describe : describe.skip;

integrationDescribe("V5.16 — real OpenAI call captures LLMEvent", () => {
  const captured: LLMEvent[] = [];

  // Collecting mock transport — verifies event structure without hitting ScopeCall ingest
  const mockTransport: Transport = {
    async send(req: ExportRequest): Promise<ExportResponse> {
      captured.push(...req.events);
      return { ok: true, status: 200 };
    },
  };

  beforeAll(() => {
    _resetInstance();
  });

  afterAll(() => {
    _resetInstance();
  });

  test("chat.completions.create produces LLMEvent with cost > 0", async () => {
    // Dynamic import so the test file parses even without openai installed
    const { default: OpenAI } = await import("openai");

    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const sdk = init({ transport: mockTransport });
    sdk.instrument(openaiClient, "openai");

    await sdk.trace("v5-16-integration", async () => {
      await openaiClient.chat.completions.create({
        model: "gpt-4o-mini", // cheapest model, minimal cost
        messages: [{ role: "user", content: "Say hi in one word." }],
        max_tokens: 5,
      });
    });

    await sdk.flush();

    // Contract assertions
    expect(captured.length).toBeGreaterThan(0);

    const event = captured[0];
    expect(event.input_tokens).toBeGreaterThan(0);
    expect(event.output_tokens).toBeGreaterThan(0);
    expect(event.cost_usd).toBeGreaterThan(0);
    expect(event.status).toBe("success");
    expect(event.provider).toBe("openai");

    // Alias resolution: API may return "gpt-4o-mini-2024-07-18"; must resolve to "gpt-4o-mini"
    expect(event.model).toBe("gpt-4o-mini");

    // cost_usd must be > 0 which proves alias resolution worked (unresolved → cost = 0)
    expect(event.cost_usd).toBeGreaterThan(0);
    expect(event.latency_ms).toBeGreaterThan(0);
    expect(event.trace_id).toBeTruthy();
    expect(event.sdk_version).toBeTruthy();
  }, 30_000); // 30s timeout for real network call
});
