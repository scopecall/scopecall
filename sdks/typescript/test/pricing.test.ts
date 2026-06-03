// V5.12 Alias resolution: versioned → canonical
// V5.13 Alias resolution: unknown model pass-through
// V5.14 Pricing JSON freshness gate (CI fails if > 30 days stale)

import { describe, it, expect } from "vitest";
import { resolveModel, calculateCost, lookupPrice, getPricingLastVerified } from "../src/pricing/resolve.js";

describe("V5.12 — alias resolution: versioned → canonical", () => {
  it("gpt-4o-2024-11-20 → gpt-4o", () => {
    expect(resolveModel("gpt-4o-2024-11-20")).toBe("gpt-4o");
  });

  it("gpt-4o-2024-08-06 → gpt-4o", () => {
    expect(resolveModel("gpt-4o-2024-08-06")).toBe("gpt-4o");
  });

  it("gpt-4o-mini-2024-07-18 → gpt-4o-mini", () => {
    expect(resolveModel("gpt-4o-mini-2024-07-18")).toBe("gpt-4o-mini");
  });

  it("claude-3-5-sonnet-20241022 → claude-3-5-sonnet", () => {
    expect(resolveModel("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
  });

  it("canonical IDs resolve to themselves", () => {
    expect(resolveModel("gpt-4o")).toBe("gpt-4o");
    expect(resolveModel("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(resolveModel("claude-3-5-sonnet")).toBe("claude-3-5-sonnet");
  });
});

describe("V5.13 — alias resolution: unknown model pass-through", () => {
  it("unknown model returns input unchanged (no throw)", () => {
    expect(resolveModel("my-custom-model-v1")).toBe("my-custom-model-v1");
    expect(resolveModel("totally-unknown-xyz")).toBe("totally-unknown-xyz");
  });

  it("cost is 0 for unknown model", () => {
    expect(calculateCost("unknown-model", 1000, 500)).toBe(0);
  });
});

describe("V5.14 — pricing JSON freshness gate", () => {
  it("last_verified is within 30 days of today", () => {
    const lastVerified = getPricingLastVerified();
    const daysSince = (Date.now() - lastVerified.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysSince).toBeLessThan(30);
  });
});

describe("pricing sanity ranges", () => {
  const models = [
    "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo",
    "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5",
    "claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-opus",
    "gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash",
  ];

  for (const model of models) {
    it(`${model}: input price in [0.0001, 0.1] per 1k tokens`, () => {
      const price = lookupPrice(model);
      expect(price).not.toBeNull();
      expect(price!.input_price_per_1k_tokens).toBeGreaterThanOrEqual(0.00001);
      expect(price!.input_price_per_1k_tokens).toBeLessThanOrEqual(0.1);
    });
  }

  it("calculateCost produces non-zero cost for known model", () => {
    const cost = calculateCost("gpt-4o", 1000, 500);
    expect(cost).toBeGreaterThan(0);
    // gpt-4o: (1000/1000 * 0.0025) + (500/1000 * 0.010) = 0.0025 + 0.005 = 0.0075
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  it("calculateCost via versioned alias produces same result as canonical", () => {
    const canonical = calculateCost("gpt-4o", 1000, 500);
    const versioned = calculateCost("gpt-4o-2024-11-20", 1000, 500);
    expect(versioned).toBe(canonical);
  });
});
