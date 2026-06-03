use axum::{extract::State, Json};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::AppState;

pub async fn handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let redis_status = check_redis(&state.redis).await;
    let kafka_status = if state.producer.is_healthy().await {
        "ok"
    } else {
        "degraded"
    };

    Json(json!({
        "status": "ok",
        "redis": redis_status,
        "kafka": kafka_status,
    }))
}

async fn check_redis(client: &redis::Client) -> &'static str {
    match client.get_multiplexed_async_connection().await {
        Ok(mut conn) => {
            let pong: redis::RedisResult<String> = redis::cmd("PING").query_async(&mut conn).await;
            if pong.is_ok() {
                "ok"
            } else {
                "degraded"
            }
        }
        Err(_) => "degraded",
    }
}
