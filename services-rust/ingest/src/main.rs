use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::{
    routing::{get, post},
    Router,
};
use common::config::Config;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

mod auth;
mod producer;
mod routes;

pub struct AppState {
    pub config: Config,
    pub pg: sqlx::PgPool,
    pub redis: redis::Client,
    pub producer: Arc<producer::KafkaProducer>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env().context("loading config")?;
    init_tracing(&config.log_format);

    let pg = sqlx::PgPool::connect(&config.database_url)
        .await
        .context("connecting to Postgres")?;

    let redis = redis::Client::open(config.redis_url.as_str()).context("opening Redis client")?;

    let producer = Arc::new(
        producer::KafkaProducer::new(&config.kafka_brokers, &config.kafka_topic)
            .await
            .context("connecting to Kafka")?,
    );

    let port = config.ingest_port;
    let state = Arc::new(AppState {
        config,
        pg,
        redis,
        producer,
    });

    let app = Router::new()
        .route("/health", get(routes::health::handler))
        .route("/v1/ingest", post(routes::ingest::handler))
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .context("binding listener")?;

    info!(port, "ingest service listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serving")
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("install ctrl-c handler");
    info!("shutdown signal received — draining");
}

fn init_tracing(format: &str) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    if format == "pretty" {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    } else {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .init();
    }
}
