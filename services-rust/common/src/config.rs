use std::env;

/// Shared configuration loaded from environment variables.
/// Each service reads only what it needs; unknown vars are ignored.
#[derive(Debug, Clone)]
pub struct Config {
    // Postgres
    pub database_url: String,

    // Redis
    pub redis_url: String,

    // Redpanda / Kafka
    pub kafka_brokers: String,
    pub kafka_topic: String,
    pub kafka_dlq_topic: String,
    pub kafka_consumer_group: String,

    // ClickHouse (processor only)
    pub clickhouse_url: String,
    pub clickhouse_database: String,

    // Processor durability — path to a file where the last-committed Kafka
    // offset is persisted. On restart, the processor resumes from
    // (stored_offset + 1) instead of dropping any backlog produced while
    // it was down. See processor/src/offset_store.rs.
    pub processor_offset_file: String,

    // Processor batching — accumulate up to this many events (or until the
    // flush interval elapses) before issuing one ClickHouse insert. Trades
    // a small amount of latency for a large drop in HTTP overhead.
    pub processor_batch_size: usize,
    pub processor_flush_interval_ms: u64,

    // Ingest service
    pub ingest_port: u16,

    // Logging
    pub log_format: String, // "json" | "pretty"
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            database_url:          require("DATABASE_URL")?,
            redis_url:             env_or("REDIS_URL", "redis://localhost:6379"),
            kafka_brokers:         env_or("KAFKA_BROKERS", "localhost:9092"),
            kafka_topic:           env_or("KAFKA_TOPIC", "events.llm_calls"),
            kafka_dlq_topic:       env_or("KAFKA_DLQ_TOPIC", "events.dlq"),
            kafka_consumer_group:  env_or("KAFKA_CONSUMER_GROUP", "scopecall-processor"),
            clickhouse_url:        env_or("CLICKHOUSE_URL", "http://localhost:8123"),
            clickhouse_database:   env_or("CLICKHOUSE_DATABASE", "default"),
            // Default path is relative to the processor's CWD. In Docker we
            // mount a persistent volume at /var/lib/scopecall and set this
            // env var to /var/lib/scopecall/processor.offset.
            processor_offset_file: env_or("PROCESSOR_OFFSET_FILE", "./data/processor.offset"),
            // 100 events / 500ms balances throughput (one HTTP roundtrip per
            // 100 inserts) against ingest-to-query latency (under 1s p95 in
            // local benchmarks). Tunable per deployment.
            processor_batch_size:  env_or("PROCESSOR_BATCH_SIZE", "100").parse().unwrap_or(100),
            processor_flush_interval_ms:
                env_or("PROCESSOR_FLUSH_INTERVAL_MS", "500").parse().unwrap_or(500),
            ingest_port:           env_or("INGEST_PORT", "3002").parse().unwrap_or(3002),
            log_format:            env_or("LOG_FORMAT", "json"),
        })
    }
}

fn require(key: &str) -> anyhow::Result<String> {
    env::var(key).map_err(|_| anyhow::anyhow!("required env var {} not set", key))
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
}
