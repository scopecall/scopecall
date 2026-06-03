use anyhow::Context;
use regex::Regex;
use serde::Deserialize;
use std::fs;

use crate::pricing::Pricer;

const PATTERNS_PATH: &str = "schemas/redaction/patterns.yaml";
const PATTERNS_FALLBACK: &str = include_str!("../../../schemas/redaction/patterns.yaml");

/// PII redaction pattern loaded from schemas/redaction/patterns.yaml.
#[derive(Debug, Deserialize)]
struct PatternDef {
    name: String,
    regex: String,
    #[allow(dead_code)]
    luhn_check: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct PatternsFile {
    order: Vec<String>,
    patterns: Vec<PatternDef>,
}

/// Two-stage enricher: PII redaction + server-authoritative pricing.
///
/// Order matters. Redaction first means the pricing lookup operates on the
/// already-redacted event (which doesn't affect anything since pricing reads
/// model + tokens, not text — but keeping a single mutate-then-return path
/// avoids future contributors accidentally reading raw input_text post-PII).
pub struct Enricher {
    // (name, regex, replacement) in application order
    patterns: Vec<(String, Regex, String)>,
    /// Server-side pricing — overwrites SDK-supplied cost_usd and populates
    /// the input/output cost components. See pricing.rs for the rationale.
    pricer: Pricer,
}

impl Enricher {
    /// Load from schemas/redaction/patterns.yaml; fall back to embedded copy.
    pub fn load() -> anyhow::Result<Self> {
        let raw =
            fs::read_to_string(PATTERNS_PATH).unwrap_or_else(|_| PATTERNS_FALLBACK.to_owned());
        let file: PatternsFile = serde_yaml::from_str(&raw).context("parsing patterns.yaml")?;

        // Build a map name → definition
        let defs: std::collections::HashMap<String, PatternDef> = file
            .patterns
            .into_iter()
            .map(|p| (p.name.clone(), p))
            .collect();

        // Compile in order
        let mut patterns = Vec::new();
        for name in &file.order {
            let def = defs
                .get(name)
                .with_context(|| format!("pattern {name} listed in order but not defined"))?;
            let re =
                Regex::new(&def.regex).with_context(|| format!("compiling regex for {name}"))?;
            patterns.push((name.clone(), re, format!("[{name}]")));
        }

        let pricer = Pricer::load().context("loading pricing table")?;
        Ok(Self { patterns, pricer })
    }

    /// Apply all PII patterns to the given text.
    pub fn redact(&self, text: &str) -> String {
        let mut result = text.to_owned();
        for (_, re, replacement) in &self.patterns {
            result = re.replace_all(&result, replacement.as_str()).into_owned();
        }
        result
    }

    /// Apply PII defense-in-depth + server-side pricing to an event.
    /// Mutates input_text, output_text, model, cost_usd, input_cost_usd,
    /// output_cost_usd in place.
    pub fn enrich(&self, event: &mut common::event::EnrichedEvent) {
        if !event.event.input_text.is_empty() {
            event.event.input_text = self.redact(&event.event.input_text);
        }
        if !event.event.output_text.is_empty() {
            event.event.output_text = self.redact(&event.event.output_text);
        }
        self.reprice(event);
    }

    /// Overwrite cost_usd + cost components from the bundled pricing table.
    /// When the model is unknown, preserve the SDK-supplied cost_usd as a
    /// fallback (better than zeroing out on the day a new model launches).
    fn reprice(&self, event: &mut common::event::EnrichedEvent) {
        // Workflow spans are synthetic containers — no model, no tokens,
        // no cost. NORMALISE these fields server-side so a buggy / hostile
        // SDK can't ship kind="workflow" with cost=999999 and poison the
        // (kind-aware) analytics. Trust the kind discriminator, not the
        // SDK-supplied content for that kind. (Round-4 review P1.)
        if event.event.kind == "workflow" {
            event.event.model = String::new();
            event.event.provider = String::new();
            event.event.input_tokens = 0;
            event.event.output_tokens = 0;
            event.event.cost_usd = 0.0;
            event.event.input_cost_usd = Some(0.0);
            event.event.output_cost_usd = Some(0.0);
            event.event.cache_read_tokens = None;
            return;
        }
        let priced = self.pricer.price(
            &event.event.model,
            event.event.input_tokens,
            event.event.output_tokens,
        );
        // Normalize the model field to its canonical name so all downstream
        // queries (cost-by-model, top-movers) group versioned and canonical
        // IDs together instead of splitting them into separate buckets.
        event.event.model = priced.canonical_model;

        if let Some(c) = priced.costs {
            event.event.cost_usd = c.total_cost_usd;
            event.event.input_cost_usd = Some(c.input_cost_usd);
            event.event.output_cost_usd = Some(c.output_cost_usd);
        }
        // else: model unknown. Leave cost_usd as SDK supplied; components
        // stay None. ClickHouse columns will hold 0 (DEFAULT 0) which makes
        // it visually obvious in queries that components weren't computed
        // server-side — distinct from a legitimate $0 call.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_email() {
        let enricher = Enricher::load().expect("load patterns");
        let result = enricher.redact("email me at test@example.com please");
        assert!(result.contains("[EMAIL]"), "got: {result}");
        assert!(!result.contains("test@example.com"));
    }

    #[test]
    fn no_false_positives_plain_text() {
        let enricher = Enricher::load().expect("load patterns");
        let text = "hello world no pii here";
        assert_eq!(enricher.redact(text), text);
    }

    fn sample_event(
        model: &str,
        in_tok: u32,
        out_tok: u32,
        sdk_cost: f64,
    ) -> common::event::EnrichedEvent {
        common::event::EnrichedEvent {
            org_id: "org_test".to_owned(),
            event: common::event::LlmEvent {
                trace_id: "t".into(),
                span_id: "s".into(),
                parent_span_id: None,
                timestamp: 0.0,
                latency_ms: 0,
                ttft_ms: None,
                model: model.to_owned(),
                provider: "openai".into(),
                input_tokens: in_tok,
                output_tokens: out_tok,
                cost_usd: sdk_cost,
                input_cost_usd: None,
                output_cost_usd: None,
                status: "success".into(),
                error_message: None,
                input_text: String::new(),
                output_text: String::new(),
                feature_name: None,
                user_id: None,
                session_id: None,
                environment: "test".into(),
                sdk_version: "test".into(),
                extra: None,
                finish_reason: None,
                cache_read_tokens: None,
                original_model: None,
                budget_state: None,
                failure_mode: None,
                tool_calls: None,
                prompt_version: None,
                kind: "llm".to_owned(),
            },
        }
    }

    #[test]
    fn enrich_overwrites_sdk_cost_for_known_model() {
        // Trust model: a misbehaving SDK that ships cost_usd=999.99 must
        // not poison the dashboard. The processor recomputes from tokens.
        let enricher = Enricher::load().expect("load");
        let mut ev = sample_event("gpt-4o", 1000, 1000, 999.99);
        enricher.enrich(&mut ev);
        // gpt-4o: $0.0025 input + $0.01 output per 1k = $0.0125 for 1k+1k
        assert!(
            (ev.event.cost_usd - 0.0125).abs() < 1e-9,
            "cost: {}",
            ev.event.cost_usd
        );
        assert_eq!(ev.event.input_cost_usd, Some(0.0025));
        assert_eq!(ev.event.output_cost_usd, Some(0.0100));
    }

    #[test]
    fn enrich_normalizes_versioned_model_to_canonical() {
        // versioned model IDs collapse to their canonical form so the
        // cost-by-model breakdown doesn't split them across buckets.
        let enricher = Enricher::load().expect("load");
        let mut ev = sample_event("gpt-4o-2024-11-20", 1000, 0, 0.0);
        enricher.enrich(&mut ev);
        assert_eq!(
            ev.event.model, "gpt-4o",
            "model field should be canonicalised"
        );
    }

    #[test]
    fn enrich_zeros_out_workflow_row_cost_fields_server_side() {
        // Round-4 review P1: a malicious/buggy SDK could ship
        // kind=workflow with cost=9999 / fake model / fake tokens to
        // bypass server-side pricing AND poison kind-aware analytics
        // (workflows are aggregated separately). Force the workflow's
        // LLM-call fields to zero/empty server-side regardless of input.
        let enricher = Enricher::load().expect("load");
        let mut ev = sample_event("evil-model", 999_999, 999_999, 9_999.99);
        ev.event.kind = "workflow".to_owned();
        ev.event.provider = "fake".to_owned();
        ev.event.cache_read_tokens = Some(42);
        enricher.enrich(&mut ev);
        assert_eq!(ev.event.kind, "workflow");
        assert_eq!(ev.event.model, "");
        assert_eq!(ev.event.provider, "");
        assert_eq!(ev.event.input_tokens, 0);
        assert_eq!(ev.event.output_tokens, 0);
        assert_eq!(ev.event.cost_usd, 0.0);
        assert_eq!(ev.event.input_cost_usd, Some(0.0));
        assert_eq!(ev.event.output_cost_usd, Some(0.0));
        assert_eq!(ev.event.cache_read_tokens, None);
    }

    #[test]
    fn enrich_preserves_sdk_cost_for_unknown_model() {
        // Operator hasn't added `o3-future` to pricing.json yet — we'd
        // rather show the SDK's best guess than $0.00 for that model. The
        // moment they add it, the cost columns light up correctly.
        let enricher = Enricher::load().expect("load");
        let mut ev = sample_event("o3-future-2099", 1000, 1000, 0.42);
        enricher.enrich(&mut ev);
        assert_eq!(ev.event.cost_usd, 0.42, "should fall back to SDK cost");
        assert_eq!(ev.event.input_cost_usd, None);
        assert_eq!(ev.event.output_cost_usd, None);
    }
}
