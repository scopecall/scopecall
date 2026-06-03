use anyhow::Context;
use common::config::Config;
use processor::{consumer, enricher, writer};
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env().context("loading config")?;
    init_tracing(&config.log_format);

    let ch = clickhouse::Client::default()
        .with_url(&config.clickhouse_url)
        .with_database(&config.clickhouse_database);

    let enricher = enricher::Enricher::load().context("loading PII patterns")?;
    let writer = writer::ClickHouseWriter::new(ch);

    info!(
        brokers = %config.kafka_brokers,
        topic   = %config.kafka_topic,
        dlq     = %config.kafka_dlq_topic,
        "processor starting"
    );

    consumer::run_consumer_loop(config, enricher, writer).await
}

fn init_tracing(format: &str) {
    use tracing_subscriber::EnvFilter;
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
