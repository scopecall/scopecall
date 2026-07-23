use axum::{
    extract::{Query, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use redis::AsyncCommands;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tracing::warn;

use crate::{auth, AppState};

/// Hard per-org cap on distinct prompt-shapes retained. Protects Redis
/// memory against a pathological number of distinct shapes in one org
/// (e.g. a bug generating unique prompt text per call defeats hashing).
const MAX_INDEX_SIZE: usize = 500;

/// 256KB cap on the POST body — findings are small structured JSON;
/// anything larger is abuse or a caller bug.
const MAX_BODY_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
pub struct SeenQuery {
    hash: String,
}

#[derive(Deserialize)]
pub struct StoreBody {
    prompt_shape_hash: String,
    feature_name: Option<String>,
    prompt_version: Option<String>,
    model: Option<String>,
    project: Option<String>,
    audit_model: Option<String>,
    findings: serde_json::Value,
}

/// GET /v1/prompt-audit/seen?hash=<h> → {"seen": bool}
///
/// The SDK's dedup gate: before spending an LLM call auditing a prompt
/// shape, it asks whether this org has already audited that shape.
pub async fn seen(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<SeenQuery>,
) -> Response {
    let raw_key = match extract_bearer(&headers) {
        Some(k) => k,
        None => return error_response(StatusCode::UNAUTHORIZED, "unauthorized"),
    };
    let org_id = match auth::resolve_key(&raw_key, &state.redis, &state.pg).await {
        Ok(id) => id,
        Err(_) => return error_response(StatusCode::UNAUTHORIZED, "unauthorized"),
    };
    if q.hash.trim().is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "bad_request");
    }

    let mut conn = match state.redis.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => {
            warn!("redis connection error: {e}");
            return error_response(StatusCode::SERVICE_UNAVAILABLE, "unavailable");
        }
    };

    let seen_key = format!("scopecall:pa:seen:{org_id}");
    let is_seen: bool = conn.sismember(&seen_key, &q.hash).await.unwrap_or(false);
    Json(json!({"seen": is_seen})).into_response()
}

/// POST /v1/prompt-audit → 202 {}
///
/// Stores the audit item blob, and marks the prompt shape in both the
/// `index` set (has stored findings) and the `seen` set (dedup gate).
/// Enforces the 500-per-org index cap.
pub async fn store(
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

    let body_bytes = match axum::body::to_bytes(request.into_body(), MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "bad_request"),
    };
    let body: StoreBody = match serde_json::from_slice(&body_bytes) {
        Ok(b) => b,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "bad_request"),
    };

    if body.prompt_shape_hash.trim().is_empty() || !body.findings.is_array() {
        return error_response(StatusCode::BAD_REQUEST, "bad_request");
    }

    let mut conn = match state.redis.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => {
            warn!("redis connection error: {e}");
            return error_response(StatusCode::SERVICE_UNAVAILABLE, "unavailable");
        }
    };

    let index_key = format!("scopecall:pa:index:{org_id}");
    let seen_key = format!("scopecall:pa:seen:{org_id}");
    let hash = body.prompt_shape_hash.as_str();

    // Cap enforcement: only NEW shapes (not already indexed) count against
    // the 500-member limit. Re-storing an existing shape is an update, not
    // growth, so it's always allowed.
    let already_indexed: bool = conn.sismember(&index_key, hash).await.unwrap_or(false);
    if !already_indexed {
        let count: usize = conn.scard(&index_key).await.unwrap_or(0);
        if count >= MAX_INDEX_SIZE {
            warn!(org_id = %org_id, hash, count, "prompt-audit index at 500-cap; dropping new item");
            // Still mark seen so the SDK's dedup gate stops re-auditing this
            // prompt shape — otherwise it burns an LLM call on every process
            // start forever with no way to ever store the result.
            let _: Result<(), _> = conn.sadd::<_, _, ()>(&seen_key, hash).await;
            return (StatusCode::ACCEPTED, Json(json!({}))).into_response();
        }
    }

    // Re-serialize the whole stored item, keeping `findings` opaque
    // (as-received JSON). `audited_at` is stamped server-side.
    let item = json!({
        "prompt_shape_hash": body.prompt_shape_hash,
        "feature_name": body.feature_name,
        "prompt_version": body.prompt_version,
        "model": body.model,
        "project": body.project,
        "audit_model": body.audit_model,
        "audited_at": Utc::now().to_rfc3339(),
        "findings": body.findings,
    });
    let item_str = match serde_json::to_string(&item) {
        Ok(s) => s,
        Err(e) => {
            warn!("serialize prompt-audit item: {e}");
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal");
        }
    };

    let item_key = format!("scopecall:pa:item:{org_id}:{hash}");
    if let Err(e) = conn.set::<_, _, ()>(&item_key, &item_str).await {
        warn!("redis set prompt-audit item failed: {e}");
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "unavailable");
    }
    let _: Result<(), _> = conn.sadd::<_, _, ()>(&index_key, hash).await;
    let _: Result<(), _> = conn.sadd::<_, _, ()>(&seen_key, hash).await;

    (StatusCode::ACCEPTED, Json(json!({}))).into_response()
}

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    let auth = headers.get("authorization")?.to_str().ok()?;
    auth.strip_prefix("Bearer ").map(str::to_owned)
}

fn error_response(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({"error": error}))).into_response()
}
