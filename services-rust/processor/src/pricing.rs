//! Server-authoritative pricing.
//!
//! ## Why this exists
//!
//! Until this module, `cost_usd` was computed by the SDK and trusted blindly.
//! That is a correctness problem on three axes:
//!
//! 1. A misbehaving or hand-rolled SDK could ship arbitrary numbers. Cost
//!    breakdowns, budget alerts, regression detection — every cost-derived
//!    metric was downstream of a number the operator did not control.
//! 2. SDK pricing data drifts. The bundled `pricing.json` in each language
//!    SDK has its own release cadence; users running old SDKs reported old
//!    prices forever. Server-side normalizes that.
//! 3. Cost components (`input_cost_usd` / `output_cost_usd`) were never
//!    populated in production data — only by the seed script. The Cost
//!    explorer's tooltip fell back to client-side recompute, which is
//!    inconsistent with the table totals and confused users.
//!
//! ## Trust model
//!
//! - Pricing data is bundled into the processor binary via `include_str!`,
//!   so a deploy is the only way to change prices. Operators can't be
//!   surprised by a runtime config flip.
//! - SDK-supplied `cost_usd` is treated as advisory: we overwrite it when
//!   pricing resolves, and preserve it as a fallback when the model is
//!   unknown (better than zeroing out and silently breaking cost views
//!   the day a new model launches).
//!
//! ## Pricing JSON shape (single source of truth: schemas/pricing/pricing.json)
//!
//! ```json
//! {
//!   "models":  { "gpt-4o": { "input_price_per_1k_tokens": 0.0025, "output_price_per_1k_tokens": 0.01 } },
//!   "aliases": { "gpt-4o-2024-11-20": "gpt-4o" }
//! }
//! ```
//!
//! Aliases resolve in a single hop — never chained. Matches the TS SDK's
//! resolveModel() behaviour so server- and client-side resolution agree.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use anyhow::Context;
use serde::Deserialize;

/// Embedded at compile time. `cargo build` re-runs when this file changes
/// (Cargo tracks include_str! inputs). Operators get fresh prices by
/// rebuilding the binary; there is no runtime hot-reload.
const PRICING_JSON: &str = include_str!("../../../schemas/pricing/pricing.json");

#[derive(Debug, Deserialize)]
struct ModelPrice {
    input_price_per_1k_tokens: f64,
    output_price_per_1k_tokens: f64,
}

#[derive(Debug, Deserialize)]
struct PricingFile {
    models: HashMap<String, ModelPrice>,
    aliases: HashMap<String, String>,
}

/// Result of pricing one event.
#[derive(Debug, Clone)]
pub struct Priced {
    /// Canonical model after alias resolution (e.g. `gpt-4o-2024-11-20` → `gpt-4o`).
    /// Returned even when pricing fails — the alias map may resolve a model
    /// whose price entry was accidentally deleted.
    pub canonical_model: String,
    /// `None` when the model is unknown. Caller decides the fallback.
    pub costs: Option<Costs>,
}

#[derive(Debug, Clone, Copy)]
pub struct Costs {
    pub input_cost_usd: f64,
    pub output_cost_usd: f64,
    pub total_cost_usd: f64,
}

pub struct Pricer {
    models: HashMap<String, ModelPrice>,
    aliases: HashMap<String, String>,
    /// Tracks models we've already warned about, so we don't spam the log
    /// on every event for a missing model. Lock contention is irrelevant —
    /// HashSet insert is microseconds, and we only hit this path for
    /// unknown models (the steady-state hot path doesn't lock).
    warned: Mutex<HashSet<String>>,
}

impl Pricer {
    /// Build a Pricer from the embedded pricing.json. Fails only on JSON
    /// parse errors — which would be caught by the test suite, not at
    /// runtime, since the JSON is compile-time embedded.
    pub fn load() -> anyhow::Result<Self> {
        let file: PricingFile =
            serde_json::from_str(PRICING_JSON).context("parsing embedded pricing.json")?;
        Ok(Self {
            models: file.models,
            aliases: file.aliases,
            warned: Mutex::new(HashSet::new()),
        })
    }

    /// Resolve a possibly-versioned model ID to its canonical pricing key.
    /// Single-hop: never chains alias → alias → canonical.
    pub fn resolve_model<'a>(&'a self, model: &'a str) -> &'a str {
        if let Some(canonical) = self.aliases.get(model) {
            return canonical.as_str();
        }
        model
    }

    /// Compute cost from token counts. Returns `Priced` with `costs: None`
    /// when the model is unknown — caller decides whether to zero out or
    /// preserve the SDK value.
    pub fn price(&self, model: &str, input_tokens: u32, output_tokens: u32) -> Priced {
        let canonical = self.resolve_model(model).to_owned();
        let Some(p) = self.models.get(&canonical) else {
            // Warn once per unknown model so a new launch (e.g. `o3-mini`)
            // doesn't drown the logs. Mutex panic recovery: poisoned mutex
            // is recoverable since we only hold short-lived inserts.
            if let Ok(mut warned) = self.warned.lock() {
                if warned.insert(canonical.clone()) {
                    tracing::warn!(
                        model = %canonical,
                        original = %model,
                        "unknown model in pricing table — falling back to SDK cost"
                    );
                }
            }
            return Priced {
                canonical_model: canonical,
                costs: None,
            };
        };

        let input_cost = (input_tokens as f64 / 1000.0) * p.input_price_per_1k_tokens;
        let output_cost = (output_tokens as f64 / 1000.0) * p.output_price_per_1k_tokens;
        // Round to 6 decimal places — matches the SDK's behaviour and is the
        // precision ClickHouse will return on aggregate queries.
        let round6 = |x: f64| (x * 1_000_000.0).round() / 1_000_000.0;
        let input_cost = round6(input_cost);
        let output_cost = round6(output_cost);
        Priced {
            canonical_model: canonical,
            costs: Some(Costs {
                input_cost_usd: input_cost,
                output_cost_usd: output_cost,
                total_cost_usd: round6(input_cost + output_cost),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> Pricer {
        Pricer::load().expect("load pricing")
    }

    #[test]
    fn known_canonical_model() {
        let pricer = p();
        let r = pricer.price("gpt-4o", 1000, 1000);
        assert_eq!(r.canonical_model, "gpt-4o");
        let c = r.costs.expect("priced");
        // gpt-4o: $0.0025/1k input, $0.01/1k output
        assert!(
            (c.input_cost_usd - 0.0025).abs() < 1e-9,
            "input: {}",
            c.input_cost_usd
        );
        assert!(
            (c.output_cost_usd - 0.0100).abs() < 1e-9,
            "output: {}",
            c.output_cost_usd
        );
        assert!(
            (c.total_cost_usd - 0.0125).abs() < 1e-9,
            "total: {}",
            c.total_cost_usd
        );
    }

    #[test]
    fn versioned_resolves_via_alias() {
        let pricer = p();
        // gpt-4o-2024-11-20 → gpt-4o (per pricing.json aliases)
        let r = pricer.price("gpt-4o-2024-11-20", 1000, 0);
        assert_eq!(r.canonical_model, "gpt-4o");
        assert!(r.costs.is_some());
    }

    #[test]
    fn unknown_model_returns_none() {
        let pricer = p();
        let r = pricer.price("gpt-99-future", 1000, 1000);
        // Canonical falls through to the original string when no alias matches.
        assert_eq!(r.canonical_model, "gpt-99-future");
        assert!(
            r.costs.is_none(),
            "unknown model must produce None so the enricher can preserve SDK cost as fallback"
        );
    }

    #[test]
    fn alias_is_single_hop() {
        // Defensive: if pricing.json ever introduces alias-chaining
        // accidentally (a-2024 → b → c), we'd get wrong canonical IDs
        // unless we explicitly recurse. We don't recurse — and this test
        // documents that contract.
        let pricer = p();
        // gpt-4-turbo-2024-04-09 → gpt-4-turbo (one hop, gpt-4-turbo is canonical)
        assert_eq!(
            pricer.resolve_model("gpt-4-turbo-2024-04-09"),
            "gpt-4-turbo"
        );
        // And gpt-4-turbo resolves to itself (no further alias).
        assert_eq!(pricer.resolve_model("gpt-4-turbo"), "gpt-4-turbo");
    }

    #[test]
    fn zero_tokens_yields_zero_cost() {
        let pricer = p();
        let r = pricer.price("gpt-4o", 0, 0);
        let c = r.costs.unwrap();
        assert_eq!(c.input_cost_usd, 0.0);
        assert_eq!(c.output_cost_usd, 0.0);
        assert_eq!(c.total_cost_usd, 0.0);
    }

    #[test]
    fn rounds_to_six_decimals() {
        // 1 input token at $0.0025/1k = $0.0000025 — should round to 0.000003
        // (banker's rounding via f64::round is even-half but at 6 decimals
        // the result is effectively unambiguous for these inputs).
        let pricer = p();
        let r = pricer.price("gpt-4o", 1, 0);
        let c = r.costs.unwrap();
        // The value 0.0000025 rounds to 0.000003 (or 0.000002 depending on
        // f64 representation). The point of the test is that the result is
        // representable to 6 decimal places exactly.
        let scaled = c.input_cost_usd * 1_000_000.0;
        assert!(
            (scaled - scaled.round()).abs() < 1e-9,
            "expected exactly 6 decimals, got {}",
            c.input_cost_usd
        );
    }

    #[test]
    fn unknown_model_warns_only_once() {
        let pricer = p();
        // First call: warns. Second call: silent (warned set short-circuits).
        // We can't easily assert on tracing output here without a subscriber,
        // but we can at least verify the warned set behaviour.
        let _ = pricer.price("fictional-model", 100, 100);
        let _ = pricer.price("fictional-model", 100, 100);
        let warned = pricer.warned.lock().unwrap();
        assert!(warned.contains("fictional-model"));
        assert_eq!(warned.len(), 1, "should track exactly one unknown model");
    }
}
