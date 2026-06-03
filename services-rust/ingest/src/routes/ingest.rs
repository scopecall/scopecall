use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use common::{
    errors::AppError,
    event::{EnrichedEvent, IngestBatch},
};
use serde_json::json;
use std::sync::Arc;
use tracing::{info, warn};

use crate::{auth, AppState};

pub async fn handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    // Extract Bearer token
    let raw_key = match extract_bearer(&headers) {
        Some(k) => k,
        None => return error_response(StatusCode::UNAUTHORIZED, "unauthorized"),
    };

    // Resolve key → org_id
    let org_id = match auth::resolve_key(&raw_key, &state.redis, &state.pg).await {
        Ok(id) => id,
        Err(AppError::Unauthorized) => {
            return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        Err(e) => {
            warn!("auth error: {e}");
            return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
        }
    };

    // Parse body
    let body = match axum::body::to_bytes(request.into_body(), 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "bad_request"),
    };
    let batch: IngestBatch = match serde_json::from_slice(&body) {
        Ok(b) => b,
        Err(e) => {
            return error_response_detail(StatusCode::BAD_REQUEST, "bad_request", &e.to_string());
        }
    };

    // Field-length validation — see common::event MAX_* constants.
    //
    // Why we validate at ingest instead of at the API: this is the first place
    // the data has been authenticated, and rejecting here means a misbehaving
    // SDK gets a synchronous 400 with the offending field name (debuggable),
    // rather than silent dashboard freeze for everyone in the org. Skipping
    // this check let a single 9MB feature_name OOM every team member's
    // browser tab via the Flow Map node label rendering path. (Fourth-pass
    // review blocker.)
    if let Err(e) = batch.validate() {
        return error_response_detail(StatusCode::BAD_REQUEST, "validation_failed", &e.0);
    }

    let n = batch.events.len();
    if n == 0 {
        return Json(json!({"received": 0})).into_response();
    }

    // Enrich events with org_id
    let enriched: Vec<EnrichedEvent> = batch
        .events
        .into_iter()
        .map(|event| EnrichedEvent {
            org_id: org_id.clone(),
            event,
        })
        .collect();

    // Serialize each enriched event as a Kafka record payload
    let payloads: Vec<Vec<u8>> = enriched
        .iter()
        .filter_map(|e| serde_json::to_vec(e).ok())
        .collect();

    // Produce to Redpanda
    match state.producer.produce_batch(payloads).await {
        Ok(()) => {
            info!(org_id, n, "events produced to Kafka");
            Json(json!({"received": n})).into_response()
        }
        Err(e) => {
            warn!("Kafka produce error: {e}");
            error_response(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        }
    }
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
