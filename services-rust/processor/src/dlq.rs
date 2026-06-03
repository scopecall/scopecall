//! Dead-Letter Queue producer.
//!
//! When the ClickHouse writer exhausts all retries, the event is wrapped in a
//! `DlqEnvelope` and published to `events.dlq`. The Go `dlq-drain` CLI can then
//! inspect, retry, or discard dead-lettered messages.
//!
//! Envelope wire format (JSON, published as Kafka record value):
//! ```json
//! {
//!   "original": { ...EnrichedEvent... },
//!   "error": "connection refused",
//!   "attempts": 3,
//!   "failed_at": "2026-05-25T10:30:00Z",
//!   "source_topic": "events.llm_calls"
//! }
//! ```

use anyhow::Context;
use common::event::EnrichedEvent;
use rskafka::{
    client::{partition::UnknownTopicHandling, Client},
    record::Record,
};
use serde::{Deserialize, Serialize};
use tracing::error;

/// Wraps a dead-lettered event with the failure context.
/// Kept in sync with the Go CLI's `DlqEnvelope` struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DlqEnvelope {
    /// The original enriched event that could not be written.
    pub original: EnrichedEvent,
    /// Last error message after all retry attempts.
    pub error: String,
    /// Total attempts made (including the final failed attempt).
    pub attempts: u32,
    /// ISO 8601 UTC timestamp of the final failure.
    pub failed_at: String,
    /// Kafka topic the event was consumed from.
    pub source_topic: String,
}

/// Async DLQ producer. Sends `DlqEnvelope` records to the `events.dlq` topic.
pub struct DlqProducer {
    client: Client,
    topic: String,
}

impl DlqProducer {
    /// Connect to Kafka and return a ready DlqProducer.
    pub async fn new(brokers: &str, topic: &str) -> anyhow::Result<Self> {
        let broker_list: Vec<String> = brokers.split(',').map(str::to_owned).collect();
        let client = rskafka::client::ClientBuilder::new(broker_list)
            .build()
            .await
            .context("DLQ Kafka client")?;

        // Auto-create DLQ topic if it doesn't exist yet (dev convenience)
        if let Ok(ctrl) = client.controller_client() {
            ctrl.create_topic(topic, 1, 1, 5_000).await.ok();
        }

        Ok(Self {
            client,
            topic: topic.to_owned(),
        })
    }

    /// Serialize `envelope` and publish to the DLQ topic.
    ///
    /// If the DLQ write itself fails, logs a CRITICAL error.
    /// The caller must still commit the Kafka offset — leaving the offset
    /// uncommitted would cause the processor to re-attempt the failing event
    /// forever (poison-pill loop).
    pub async fn send(&self, envelope: DlqEnvelope) -> anyhow::Result<()> {
        let payload = serde_json::to_vec(&envelope).context("serializing DlqEnvelope")?;

        let partition = self
            .client
            .partition_client(self.topic.clone(), 0, UnknownTopicHandling::Retry)
            .await
            .context("DLQ partition client")?;

        let record = Record {
            key: None,
            value: Some(payload),
            headers: Default::default(),
            timestamp: chrono::Utc::now(),
        };

        partition
            .produce(
                vec![record],
                rskafka::client::partition::Compression::NoCompression,
            )
            .await
            .context("producing to DLQ")?;

        Ok(())
    }
}

/// Write `event` to ClickHouse, retrying up to `max_attempts` times with
/// exponential backoff. On exhaustion, dead-letters to `dlq`.
///
/// Always returns — the offset must be committed regardless of outcome to
/// prevent poison-pill looping.
pub async fn write_with_retry(
    event: EnrichedEvent,
    writer: &crate::writer::ClickHouseWriter,
    dlq: &DlqProducer,
    source_topic: &str,
    max_attempts: u32,
) {
    let mut last_error = String::new();
    let base_backoff_ms: u64 = 1_000;

    for attempt in 1..=max_attempts {
        match writer.insert_batch(vec![event.clone()]).await {
            Ok(()) => {
                tracing::info!(attempt, "row written to ClickHouse");
                return;
            }
            Err(e) => {
                last_error = e.to_string();
                tracing::warn!(attempt, error = %e, "ClickHouse write failed");
                if attempt < max_attempts {
                    // Exponential backoff: 1s, 2s, 4s, …
                    let backoff = base_backoff_ms * (1u64 << (attempt - 1));
                    tokio::time::sleep(tokio::time::Duration::from_millis(backoff)).await;
                }
            }
        }
    }

    // All attempts exhausted — publish to DLQ
    error!(
        error = %last_error,
        attempts = max_attempts,
        "ClickHouse write exhausted retries — dead-lettering event"
    );

    let envelope = DlqEnvelope {
        original: event,
        error: last_error,
        attempts: max_attempts,
        failed_at: chrono::Utc::now().to_rfc3339(),
        source_topic: source_topic.to_owned(),
    };

    if let Err(e) = dlq.send(envelope).await {
        error!(error = %e, "CRITICAL: DLQ send failed — event may be lost");
    }
}
