use anyhow::Context;
use rskafka::{
    client::{Client, ClientBuilder, partition::UnknownTopicHandling},
    record::Record,
};
use std::sync::Arc;

pub struct KafkaProducer {
    client: Arc<Client>,
    topic: String,
}

impl KafkaProducer {
    pub async fn new(brokers: &str, topic: &str) -> anyhow::Result<Self> {
        let broker_list: Vec<String> = brokers.split(',').map(str::to_owned).collect();
        let client = ClientBuilder::new(broker_list)
            .build()
            .await
            .context("building Kafka client")?;

        Ok(Self {
            client: Arc::new(client),
            topic: topic.to_owned(),
        })
    }

    /// Produce a batch of JSON-encoded events to the configured topic.
    pub async fn produce_batch(&self, payloads: Vec<Vec<u8>>) -> anyhow::Result<()> {
        let controller = self.client.controller_client().context("controller client")?;

        // Auto-create topic if missing (dev convenience — prod uses pre-created topics)
        controller
            .create_topic(&self.topic, 1, 1, 5_000)
            .await
            .ok(); // ignore AlreadyExists

        let partition = self
            .client
            .partition_client(self.topic.clone(), 0, UnknownTopicHandling::Retry)
            .await
            .context("partition client")?;

        let records: Vec<Record> = payloads
            .into_iter()
            .map(|payload| Record {
                key: None,
                value: Some(payload),
                headers: Default::default(),
                // rskafka Record.timestamp is chrono::DateTime<Utc>
                timestamp: chrono::Utc::now(),
            })
            .collect();

        partition
            .produce(records, rskafka::client::partition::Compression::NoCompression)
            .await
            .context("producing records")?;

        Ok(())
    }

    /// Check reachability — used by /health.
    pub async fn is_healthy(&self) -> bool {
        self.client.controller_client().is_ok()
    }
}
