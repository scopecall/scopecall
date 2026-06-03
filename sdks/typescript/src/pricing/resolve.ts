// Pricing data is bundled at build time from schemas/pricing/pricing.json.
// tsup copies the JSON via loader: { ".json": "copy" }.
// At runtime there is ZERO file I/O.

// NodeNext module resolution requires an import attribute for JSON imports
// (TS1543). tsup bundles this JSON at build time (loader: { ".json": "copy" }),
// so there is no runtime file I/O — the attribute is purely a type-system
// requirement for the source to compile under module: NodeNext.
import pricingData from "./pricing.json" with { type: "json" };

interface ModelPrice {
  input_price_per_1k_tokens: number;
  output_price_per_1k_tokens: number;
}

interface PricingJson {
  _meta: { last_verified: string };
  models: Record<string, ModelPrice>;
  aliases: Record<string, string>;
}

const pricing = pricingData as PricingJson;

/**
 * Resolve a potentially-versioned model ID to its canonical pricing key.
 *
 * Single-hop only: versioned → canonical. Never chains.
 * On miss (unknown model): returns the input unchanged, cost will be 0.00.
 *
 * @example
 *   resolveModel("gpt-4o-2024-11-20") // → "gpt-4o"
 *   resolveModel("gpt-4o")            // → "gpt-4o"
 *   resolveModel("unknown-model-v9")  // → "unknown-model-v9"
 */
export function resolveModel(modelId: string): string {
  const alias = pricing.aliases[modelId];
  if (alias) return alias; // one hop — never follow the result again
  if (pricing.models[modelId]) return modelId; // already canonical
  return modelId; // unknown: pass through; caller gets cost_usd = 0
}

/**
 * Look up the price entry for a model ID.
 * Resolves aliases automatically.
 * Returns null if the model is unknown.
 */
export function lookupPrice(modelId: string): ModelPrice | null {
  const canonical = resolveModel(modelId);
  return pricing.models[canonical] ?? null;
}

/**
 * Calculate cost in USD for a completed LLM call.
 * Returns 0 for unknown models (never throws).
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const price = lookupPrice(modelId);
  if (!price) return 0;
  const cost =
    (inputTokens / 1000) * price.input_price_per_1k_tokens +
    (outputTokens / 1000) * price.output_price_per_1k_tokens;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}

/** Exposed for V5.14 freshness test — parse the last_verified date. */
export function getPricingLastVerified(): Date {
  return new Date(pricing._meta.last_verified);
}
