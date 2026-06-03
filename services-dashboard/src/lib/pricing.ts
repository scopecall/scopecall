// Approximate per-model pricing in USD per 1M tokens.
// Mirrors the rates the seed-data generator uses so the UI's breakdown lines
// up exactly with the stored cost_usd. In production this table belongs on
// the backend (so input/output cost is stored, not recomputed at display) —
// the schema already has fields for it. Until that lands, this gives us the
// Langfuse-style hover breakdown without a backend change.
//
// Sources approximated from each provider's public pricing pages.

interface ModelRates {
  in: number;  // $ per 1M input tokens
  out: number; // $ per 1M output tokens
}

const MODEL_RATES: Record<string, ModelRates> = {
  "gpt-4o":             { in: 2.5,   out: 10.0 },
  "gpt-4o-mini":        { in: 0.15,  out: 0.6 },
  "gpt-4-turbo":        { in: 10.0,  out: 30.0 },
  "o1-preview":         { in: 15.0,  out: 60.0 },
  "claude-3-5-sonnet":  { in: 3.0,   out: 15.0 },
  "claude-3-haiku":     { in: 0.25,  out: 1.25 },
  "claude-3-opus":      { in: 15.0,  out: 75.0 },
  "gemini-1.5-pro":     { in: 3.5,   out: 10.5 },
  "gemini-1.5-flash":   { in: 0.075, out: 0.3 },
  "llama-3.1-70b":      { in: 0.9,   out: 0.9 },
};

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** false when we had to derive the split proportionally (model not in table). */
  exact: boolean;
}

/**
 * Split a span's stored cost_usd into input and output components.
 *
 *  - If we know the model's rates, compute exactly: rate * tokens / 1M.
 *  - If the model is unknown, fall back to splitting the stored total
 *    proportionally by token count (close-enough heuristic — output is usually
 *    ~3-5x more expensive per token, so this under-represents output cost).
 */
export function costBreakdown(
  model: string,
  inputTokens: number,
  outputTokens: number,
  totalCost: number,
): CostBreakdown {
  const rates = MODEL_RATES[model];
  if (rates) {
    const inputCost = (inputTokens / 1_000_000) * rates.in;
    const outputCost = (outputTokens / 1_000_000) * rates.out;
    return { inputCost, outputCost, totalCost: inputCost + outputCost, exact: true };
  }
  // Proportional fallback by token count
  const total = inputTokens + outputTokens;
  if (total === 0) {
    return { inputCost: 0, outputCost: 0, totalCost, exact: false };
  }
  const inputCost = (inputTokens / total) * totalCost;
  return {
    inputCost,
    outputCost: totalCost - inputCost,
    totalCost,
    exact: false,
  };
}
