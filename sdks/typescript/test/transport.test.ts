// Transport selection + wire format correctness

import { describe, it, expect, beforeEach } from "vitest";
import { init, _resetInstance, ConfigError } from "../src/index.js";
import { toWire } from "../src/wire/llm-event.js";
import type { LLMEvent } from "../src/wire/llm-event.js";

beforeEach(() => {
  _resetInstance();
});

describe("ConfigError — no transport configured", () => {
  it("throws ConfigError when nothing is set", () => {
    expect(() => init({})).toThrow(ConfigError);
    expect(() => init({})).toThrow(/apiKey|output|debug|transport/i);
  });
});

describe("toWire() — LLMEvent serialization", () => {
  // Fixture matches the CURRENT contract. `satisfies LLMEvent` enforces
  // at compile time that we're not regressing the wire shape — the
  // previous fixture was stale and still used the original pre-fix
  // shape (trace_id: null, timestamp: ISO string).
  const event = {
    span_id: "abc-123",
    trace_id: "abc-123",         // non-null required; synth single-span trace
    parent_span_id: null,
    timestamp: 1779705600000,    // Unix epoch ms (number)
    latency_ms: 250,
    ttft_ms: null,
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.00075,
    status: "success",
    error_message: null,
    input_text: "Hello",
    output_text: "World",
    feature_name: null,
    user_id: null,
    session_id: null,
    environment: "test",
    sdk_version: "0.1.0",
    extra: null,
    finish_reason: null,
    cache_read_tokens: null,
    original_model: null,
    budget_state: null,
    failure_mode: null,
    tool_calls: null,
    prompt_version: null,
    kind: "llm",
  } satisfies LLMEvent;

  it("serialises to valid JSON", () => {
    const wire = toWire(event);
    expect(() => JSON.parse(wire)).not.toThrow();
  });

  it("nullable fields preserve null (undefined → null replacer)", () => {
    const parsed = JSON.parse(toWire(event));
    expect(parsed.parent_span_id).toBeNull();
    expect(parsed.ttft_ms).toBeNull();
    expect(parsed.extra).toBeNull();
    expect(parsed.prompt_version).toBeNull();
    // trace_id is NOT nullable on the current contract — it's a string.
    expect(typeof parsed.trace_id).toBe("string");
  });

  it("snake_case keys are present on wire output", () => {
    const parsed = JSON.parse(toWire(event));
    expect(parsed).toHaveProperty("span_id");
    expect(parsed).toHaveProperty("input_tokens");
    expect(parsed).toHaveProperty("output_tokens");
    expect(parsed).toHaveProperty("cost_usd");
    expect(parsed).toHaveProperty("latency_ms");
  });

  it("no camelCase keys leak onto wire", () => {
    const parsed = JSON.parse(toWire(event));
    expect(parsed).not.toHaveProperty("spanId");
    expect(parsed).not.toHaveProperty("inputTokens");
    expect(parsed).not.toHaveProperty("costUsd");
  });
});
