//! OpenTelemetry GenAI ingest bridge — `POST /v1/traces`.
//!
//! Accepts OTLP/HTTP **JSON** trace export (the body an OTel SDK / Collector
//! sends to a traces endpoint) and maps spans following the GenAI semantic
//! conventions (`gen_ai.*` attributes) into ScopeCall's internal `LlmEvent`,
//! then publishes them through the same Kafka producer as `/v1/ingest`.
//!
//! This is the "works with anything" path: any framework already emitting
//! OTel GenAI spans (via OpenLLMetry / OpenInference auto-instrumentors for
//! LangChain, LlamaIndex, Bedrock, Vertex, etc.) can point its OTLP exporter
//! at this endpoint with `Authorization: Bearer sc_live_...` and get traces,
//! orchestration, and server-side cost attribution with zero ScopeCall code.
//!
//! Mapping summary:
//!   * span with any `gen_ai.*` attribute      → kind="llm"
//!   * any other span                           → kind="workflow" (container)
//!   * `gen_ai.system`                          → provider
//!   * `gen_ai.response.model` / `.request.model` → model
//!   * `gen_ai.usage.input_tokens|prompt_tokens`  → input_tokens
//!   * `gen_ai.usage.output_tokens|completion_tokens` → output_tokens
//!   * OTLP status.code == 2 (ERROR)            → status="error"
//!   * (endTime − startTime)                    → latency_ms
//!   * resource `deployment.environment`        → environment (default "production")
//!   * resource `service.name`                  → project (default "" = unassigned)
//!
//! cost_usd is left 0 — the processor reprices from the bundled table, so
//! the cost-source trust signal works for OTel traffic exactly as for SDK
//! traffic.

use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use common::event::{EnrichedEvent, LlmEvent, MAX_BATCH_EVENTS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{info, warn};

use crate::{auth, AppState};

pub async fn handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    let raw_key = match extract_bearer(&headers) {
        Some(k) => k,
        None => return error_response(StatusCode::UNAUTHORIZED, "unauthorized"),
    };

    let org_id = match auth::resolve_key(&raw_key, &state.redis, &state.pg).await {
        Ok(id) => id,
        Err(_) => return error_response(StatusCode::UNAUTHORIZED, "unauthorized"),
    };

    let body = match axum::body::to_bytes(request.into_body(), 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "bad_request"),
    };
    let export: ExportTraceServiceRequest = match serde_json::from_slice(&body) {
        Ok(b) => b,
        Err(e) => {
            return error_response_detail(StatusCode::BAD_REQUEST, "bad_request", &e.to_string())
        }
    };

    // Flatten resourceSpans → scopeSpans → spans, mapping each to an LlmEvent.
    // Resource-level attributes (e.g. deployment.environment) are inherited by
    // every span under that resource.
    let mut events: Vec<LlmEvent> = Vec::new();
    for rs in &export.resource_spans {
        let environment = rs
            .resource
            .as_ref()
            .and_then(|r| attr_str(&r.attributes, "deployment.environment"))
            .or_else(|| {
                rs.resource
                    .as_ref()
                    .and_then(|r| attr_str(&r.attributes, "deployment.environment.name"))
            })
            .unwrap_or_else(|| "production".to_owned());
        // OTLP's canonical application label is resource `service.name` —
        // map it to `project` (ScopeCall's app dimension). Default "" =
        // unassigned, mirroring the JSON-ingest path.
        let project = rs
            .resource
            .as_ref()
            .and_then(|r| attr_str(&r.attributes, "service.name"))
            .unwrap_or_default();

        for ss in &rs.scope_spans {
            for span in &ss.spans {
                if events.len() >= MAX_BATCH_EVENTS {
                    warn!(
                        org_id,
                        max = MAX_BATCH_EVENTS,
                        "OTLP request exceeded max spans; remaining dropped"
                    );
                    break;
                }
                if let Some(ev) = map_span(span, &environment, &project) {
                    events.push(ev);
                }
            }
        }
    }

    let n = events.len();
    if n == 0 {
        return Json(json!({"received": 0})).into_response();
    }

    // Validate (field caps + closed enums) exactly like the SDK path.
    for (i, ev) in events.iter().enumerate() {
        if let Err(e) = ev.validate() {
            return error_response_detail(
                StatusCode::BAD_REQUEST,
                "validation_failed",
                &format!("spans[{i}]: {}", e.0),
            );
        }
    }

    let payloads: Vec<Vec<u8>> = events
        .into_iter()
        .filter_map(|event| {
            serde_json::to_vec(&EnrichedEvent {
                org_id: org_id.clone(),
                event,
            })
            .ok()
        })
        .collect();

    match state.producer.produce_batch(payloads).await {
        Ok(()) => {
            info!(org_id, n, "OTLP spans produced to Kafka");
            Json(json!({"received": n})).into_response()
        }
        Err(e) => {
            warn!("Kafka produce error: {e}");
            error_response(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        }
    }
}

// ── span → LlmEvent mapping ────────────────────────────────────────────────

fn map_span(span: &OtlpSpan, environment: &str, project: &str) -> Option<LlmEvent> {
    // Skip spans with no id — they can't participate in the trace tree.
    if span.trace_id.is_empty() || span.span_id.is_empty() {
        return None;
    }

    let is_genai = span.attributes.iter().any(|kv| kv.key.starts_with("gen_ai."));
    let kind = if is_genai { "llm" } else { "workflow" };

    let start_nanos = span.start_time_unix_nano.as_ref().and_then(as_u64).unwrap_or(0);
    let end_nanos = span.end_time_unix_nano.as_ref().and_then(as_u64).unwrap_or(start_nanos);
    let timestamp_ms = (start_nanos / 1_000_000) as f64;
    let latency_ms = end_nanos.saturating_sub(start_nanos) / 1_000_000;

    let status = match span.status.as_ref().map(|s| s.code).unwrap_or(0) {
        2 => "error",
        _ => "success",
    };
    let error_message = if status == "error" {
        span.status
            .as_ref()
            .and_then(|s| s.message.clone())
            .filter(|m| !m.is_empty())
    } else {
        None
    };

    let (model, provider, input_tokens, output_tokens, finish_reason) = if is_genai {
        let model = attr_str(&span.attributes, "gen_ai.response.model")
            .or_else(|| attr_str(&span.attributes, "gen_ai.request.model"))
            .unwrap_or_else(|| "unknown".to_owned());
        let provider = attr_str(&span.attributes, "gen_ai.system")
            .or_else(|| attr_str(&span.attributes, "gen_ai.provider.name"))
            .unwrap_or_else(|| "unknown".to_owned());
        let input_tokens = attr_int(&span.attributes, "gen_ai.usage.input_tokens")
            .or_else(|| attr_int(&span.attributes, "gen_ai.usage.prompt_tokens"))
            .unwrap_or(0) as u32;
        let output_tokens = attr_int(&span.attributes, "gen_ai.usage.output_tokens")
            .or_else(|| attr_int(&span.attributes, "gen_ai.usage.completion_tokens"))
            .unwrap_or(0) as u32;
        let finish_reason = attr_str(&span.attributes, "gen_ai.response.finish_reasons")
            .or_else(|| attr_str(&span.attributes, "gen_ai.response.finish_reason"));
        (model, provider, input_tokens, output_tokens, finish_reason)
    } else {
        // Container span: zeroed model/tokens; the processor enforces this too.
        (String::new(), String::new(), 0, 0, None)
    };

    let parent_span_id = if span.parent_span_id.is_empty() {
        None
    } else {
        Some(truncate(&span.parent_span_id, common::event::MAX_ID_LEN))
    };

    let customer_id = attr_str(&span.attributes, "gen_ai.customer.id")
        .or_else(|| attr_str(&span.attributes, "scopecall.customer_id"));
    let prompt_version = attr_str(&span.attributes, "scopecall.prompt_version");
    let user_id = attr_str(&span.attributes, "gen_ai.user.id")
        .or_else(|| attr_str(&span.attributes, "enduser.id"));
    let session_id = attr_str(&span.attributes, "gen_ai.conversation.id")
        .or_else(|| attr_str(&span.attributes, "session.id"));

    let feature_name = if span.name.is_empty() {
        None
    } else {
        Some(truncate(&span.name, common::event::MAX_LABEL_LEN))
    };

    Some(LlmEvent {
        trace_id: truncate(&span.trace_id, common::event::MAX_ID_LEN),
        span_id: truncate(&span.span_id, common::event::MAX_ID_LEN),
        parent_span_id,
        timestamp: timestamp_ms,
        latency_ms: latency_ms.min(u32::MAX as u64) as u32,
        ttft_ms: None,
        model,
        provider,
        input_tokens,
        output_tokens,
        cost_usd: 0.0,
        input_cost_usd: None,
        output_cost_usd: None,
        status: status.to_owned(),
        error_message,
        input_text: String::new(),
        output_text: String::new(),
        feature_name,
        user_id,
        session_id,
        customer_id,
        attempt_number: 1,
        retry_reason: None,
        is_test: false,
        cache_read_cost_usd: None,
        cost_source: None,
        pricing_version: None,
        environment: truncate(environment, common::event::MAX_LABEL_LEN),
        project: truncate(project, common::event::MAX_LABEL_LEN),
        sdk_version: "otel-bridge".to_owned(),
        extra: None,
        finish_reason,
        cache_read_tokens: None,
        original_model: None,
        budget_state: None,
        failure_mode: None,
        tool_calls: None,
        prompt_version,
        kind: kind.to_owned(),
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_owned()
    } else {
        s.chars().take(max).collect()
    }
}

// ── OTLP attribute helpers ─────────────────────────────────────────────────

fn attr_str(attrs: &[KeyValue], key: &str) -> Option<String> {
    let v = &attrs.iter().find(|kv| kv.key == key)?.value;
    if let Some(s) = &v.string_value {
        return Some(s.clone());
    }
    // GenAI sometimes encodes finish_reasons as an array; fall back to a
    // joined string. Other scalar shapes coerce to their display form.
    if let Some(arr) = &v.array_value {
        let parts: Vec<String> = arr
            .values
            .iter()
            .filter_map(|av| av.string_value.clone())
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(","));
        }
    }
    None
}

fn attr_int(attrs: &[KeyValue], key: &str) -> Option<i64> {
    let v = &attrs.iter().find(|kv| kv.key == key)?.value;
    if let Some(iv) = &v.int_value {
        return as_i64(iv);
    }
    if let Some(d) = v.double_value {
        return Some(d as i64);
    }
    None
}

// OTLP/JSON encodes int64/uint64 as strings, but some exporters emit raw
// numbers. Accept either shape.
fn as_u64(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

fn as_i64(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

// ── OTLP/JSON wire structs (minimal subset we map) ─────────────────────────

#[derive(Debug, Deserialize)]
struct ExportTraceServiceRequest {
    #[serde(default, rename = "resourceSpans")]
    resource_spans: Vec<ResourceSpans>,
}

#[derive(Debug, Deserialize)]
struct ResourceSpans {
    #[serde(default)]
    resource: Option<Resource>,
    #[serde(default, rename = "scopeSpans")]
    scope_spans: Vec<ScopeSpans>,
}

#[derive(Debug, Deserialize)]
struct Resource {
    #[serde(default)]
    attributes: Vec<KeyValue>,
}

#[derive(Debug, Deserialize)]
struct ScopeSpans {
    #[serde(default)]
    spans: Vec<OtlpSpan>,
}

#[derive(Debug, Deserialize)]
struct OtlpSpan {
    #[serde(default, rename = "traceId")]
    trace_id: String,
    #[serde(default, rename = "spanId")]
    span_id: String,
    #[serde(default, rename = "parentSpanId")]
    parent_span_id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "startTimeUnixNano")]
    start_time_unix_nano: Option<Value>,
    #[serde(default, rename = "endTimeUnixNano")]
    end_time_unix_nano: Option<Value>,
    #[serde(default)]
    attributes: Vec<KeyValue>,
    #[serde(default)]
    status: Option<OtlpStatus>,
}

#[derive(Debug, Deserialize)]
struct OtlpStatus {
    #[serde(default)]
    code: i32,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KeyValue {
    key: String,
    #[serde(default)]
    value: AnyValue,
}

#[derive(Debug, Default, Deserialize)]
struct AnyValue {
    #[serde(default, rename = "stringValue")]
    string_value: Option<String>,
    #[serde(default, rename = "intValue")]
    int_value: Option<Value>,
    #[serde(default, rename = "doubleValue")]
    double_value: Option<f64>,
    #[serde(default, rename = "arrayValue")]
    array_value: Option<ArrayValue>,
}

#[derive(Debug, Deserialize)]
struct ArrayValue {
    #[serde(default)]
    values: Vec<AnyValue>,
}

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    let auth = headers.get("authorization")?.to_str().ok()?;
    auth.strip_prefix("Bearer ").map(str::to_owned)
}

fn error_response(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({"error": error}))).into_response()
}

fn error_response_detail(status: StatusCode, error: &str, detail: &str) -> Response {
    (status, Json(json!({"error": error, "detail": detail}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(key: &str, s: &str) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            value: AnyValue {
                string_value: Some(s.to_owned()),
                ..Default::default()
            },
        }
    }
    fn kv_int(key: &str, n: i64) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            value: AnyValue {
                int_value: Some(Value::String(n.to_string())),
                ..Default::default()
            },
        }
    }

    #[test]
    fn maps_genai_span_to_llm_event() {
        let span = OtlpSpan {
            trace_id: "abc123".into(),
            span_id: "span1".into(),
            parent_span_id: "parent1".into(),
            name: "chat gpt-4o".into(),
            start_time_unix_nano: Some(Value::String("1000000000".into())), // 1000 ms
            end_time_unix_nano: Some(Value::String("3000000000".into())),   // 3000 ms
            attributes: vec![
                kv("gen_ai.system", "openai"),
                kv("gen_ai.request.model", "gpt-4o"),
                kv_int("gen_ai.usage.input_tokens", 120),
                kv_int("gen_ai.usage.output_tokens", 48),
            ],
            status: Some(OtlpStatus { code: 1, message: None }),
        };
        let ev = map_span(&span, "production", "").expect("event");
        assert_eq!(ev.kind, "llm");
        assert_eq!(ev.provider, "openai");
        assert_eq!(ev.model, "gpt-4o");
        assert_eq!(ev.input_tokens, 120);
        assert_eq!(ev.output_tokens, 48);
        assert_eq!(ev.latency_ms, 2000);
        assert_eq!(ev.timestamp, 1000.0);
        assert_eq!(ev.parent_span_id.as_deref(), Some("parent1"));
        assert_eq!(ev.status, "success");
        assert!(ev.validate().is_ok());
    }

    #[test]
    fn maps_non_genai_span_to_container() {
        let span = OtlpSpan {
            trace_id: "abc123".into(),
            span_id: "span2".into(),
            parent_span_id: String::new(),
            name: "my_workflow".into(),
            start_time_unix_nano: Some(Value::Number(0.into())),
            end_time_unix_nano: Some(Value::Number(0.into())),
            attributes: vec![],
            status: None,
        };
        let ev = map_span(&span, "staging", "svc-a").expect("event");
        assert_eq!(ev.kind, "workflow");
        assert_eq!(ev.model, "");
        assert_eq!(ev.input_tokens, 0);
        assert_eq!(ev.parent_span_id, None);
        assert_eq!(ev.environment, "staging");
        assert_eq!(ev.project, "svc-a");
        assert!(ev.validate().is_ok());
    }

    #[test]
    fn error_status_maps_through() {
        let span = OtlpSpan {
            trace_id: "t".into(),
            span_id: "s".into(),
            parent_span_id: String::new(),
            name: "call".into(),
            start_time_unix_nano: None,
            end_time_unix_nano: None,
            attributes: vec![kv("gen_ai.system", "anthropic")],
            status: Some(OtlpStatus { code: 2, message: Some("overloaded".into()) }),
        };
        let ev = map_span(&span, "production", "").unwrap();
        assert_eq!(ev.status, "error");
        assert_eq!(ev.error_message.as_deref(), Some("overloaded"));
    }
}
