use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use common::{config::Config, event::EnrichedEvent};
use futures::StreamExt;
use rskafka::client::{
    consumer::{StartOffset, StreamConsumerBuilder},
    partition::UnknownTopicHandling,
    ClientBuilder,
};
use tokio::time::interval;
use tracing::{error, info, warn};

use crate::{
    dlq::{write_with_retry, DlqProducer},
    enricher::Enricher,
    offset_store::OffsetStore,
    writer::ClickHouseWriter,
};

/// Maximum ClickHouse write attempts before dead-lettering a batch.
const MAX_WRITE_ATTEMPTS: u32 = 3;

/// Holds an event plus the Kafka offset it came from. We track offsets so
/// that after a successful batch flush we persist `max(offset)` of that
/// batch — restarts then resume from `max_offset + 1` instead of replaying
/// or skipping. The offset moves through the pipeline alongside the event
/// instead of being committed inside the rskafka stream (which doesn't
/// expose group-commit by itself).
struct Pending {
    event: EnrichedEvent,
    offset: i64,
}

pub async fn run_consumer_loop(
    config: Config,
    enricher: Enricher,
    writer: ClickHouseWriter,
) -> anyhow::Result<()> {
    let broker_list: Vec<String> = config
        .kafka_brokers
        .split(',')
        .map(str::to_owned)
        .collect();

    let client = ClientBuilder::new(broker_list)
        .build()
        .await
        .context("Kafka client")?;

    // DLQ producer — shares the same broker connection pool
    let dlq = DlqProducer::new(&config.kafka_brokers, &config.kafka_dlq_topic)
        .await
        .context("DLQ producer")?;

    let partition = Arc::new(
        client
            .partition_client(
                config.kafka_topic.clone(),
                0,
                UnknownTopicHandling::Retry,
            )
            .await
            .context("partition client")?,
    );

    // Durable offset store. On first run (no file present) we start from
    // Earliest — that preserves any pre-existing backlog from a topic that
    // was populated before the processor came online. Subsequent runs
    // resume from the last persisted offset. We NEVER fall back to Latest,
    // which is the silent-drop behaviour the offset store exists to fix.
    let offset_store = OffsetStore::new(&config.processor_offset_file);
    let start_offset = match offset_store.load() {
        Some(off) => {
            info!(
                offset = off,
                path = %config.processor_offset_file,
                "resuming from persisted offset"
            );
            StartOffset::At(off + 1)
        }
        None => {
            info!(
                path = %config.processor_offset_file,
                "no persisted offset; starting from Earliest"
            );
            StartOffset::Earliest
        }
    };

    let mut stream = StreamConsumerBuilder::new(partition, start_offset)
        .with_max_batch_size(1000)
        .with_max_wait_ms(5_000)
        .build();

    info!(
        topic = %config.kafka_topic,
        dlq_topic = %config.kafka_dlq_topic,
        batch_size = config.processor_batch_size,
        flush_interval_ms = config.processor_flush_interval_ms,
        "consumer loop started — max_write_attempts={MAX_WRITE_ATTEMPTS}"
    );

    // Accumulator: events are appended here as they arrive from Kafka, then
    // flushed to ClickHouse as a single batch on either size threshold or
    // time tick — whichever fires first. The select! below drives both.
    let mut buf: Vec<Pending> = Vec::with_capacity(config.processor_batch_size);
    // Highest offset we've observed (whether or not it produced a valid
    // event). Parse failures bump this without adding to `buf`; the next
    // flush persists it so the bad record is skipped on restart. Tracking
    // this separately is what prevents the "save bad-record offset
    // immediately and lose still-buffered good records below it" bug.
    let mut max_offset_seen: i64 = -1;
    let mut flush_tick = interval(Duration::from_millis(config.processor_flush_interval_ms));
    // Skip the initial immediate tick so we don't flush an empty buffer.
    flush_tick.tick().await;

    loop {
        // tokio::select! with biased ordering: prefer draining the Kafka
        // stream first when both branches are ready. Without `biased`, the
        // runtime makes a pseudo-random choice every iteration; under load
        // the time branch can starve the stream branch, capping throughput.
        tokio::select! {
            biased;
            maybe_msg = stream.next() => {
                match maybe_msg {
                    None => {
                        // Stream ended — flush whatever is buffered before exiting.
                        flush(&mut buf, &writer, &dlq, &offset_store, &config.kafka_topic, max_offset_seen).await;
                        info!("Kafka stream ended; consumer loop exiting");
                        return Ok(());
                    }
                    Some(Err(e)) => {
                        error!("Kafka consume error: {e}");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    Some(Ok((rec, _hwm))) => {
                        let offset = rec.offset;
                        if offset > max_offset_seen { max_offset_seen = offset; }
                        let Some(payload) = &rec.record.value else { continue };

                        match serde_json::from_slice::<EnrichedEvent>(payload) {
                            Err(e) => {
                                // Malformed payload — can't enrich/write/DLQ
                                // meaningfully. `max_offset_seen` was already
                                // bumped above, so the next batch flush will
                                // persist past this record. We do NOT save
                                // the offset immediately: any still-buffered
                                // events with LOWER offsets must flush first
                                // or they'd be silently dropped on restart.
                                warn!(error = %e, offset, "deserialization error — skipping record");
                            }
                            Ok(mut ev) => {
                                enricher.enrich(&mut ev);
                                buf.push(Pending { event: ev, offset });

                                if buf.len() >= config.processor_batch_size {
                                    flush(&mut buf, &writer, &dlq, &offset_store, &config.kafka_topic, max_offset_seen).await;
                                    // Reset the timer so we don't immediately
                                    // fire a redundant time-triggered flush
                                    // on an empty buffer.
                                    flush_tick.reset();
                                }
                            }
                        }
                    }
                }
            }
            _ = flush_tick.tick() => {
                // Always try to advance the offset on tick — even when buf
                // is empty, max_offset_seen may have advanced (parse-failure
                // runs of bad records) and we need to skip past them so a
                // restart doesn't replay the whole poison sequence.
                if !buf.is_empty() {
                    flush(&mut buf, &writer, &dlq, &offset_store, &config.kafka_topic, max_offset_seen).await;
                } else if max_offset_seen >= 0 {
                    // No events to write, but offset has moved (parse
                    // failures). Persist directly.
                    if let Err(e) = offset_store.save(max_offset_seen) {
                        error!(error = %e, offset = max_offset_seen, "failed to persist offset (idle tick)");
                    }
                }
            }
        }
    }
}

/// Drain `buf` into one ClickHouse insert. On success: persist the max
/// offset to the durable store, so a restart resumes from offset+1.
/// On failure: fall back to per-event retry-then-DLQ via
/// `write_with_retry`, and STILL advance the offset (DLQ is the terminal
/// state — replaying would just dead-letter again).
///
/// ## Idempotency
///
/// The ClickHouse `llm_calls` table uses `ReplacingMergeTree` with
/// `ORDER BY (org_id, timestamp, span_id)`. Duplicate `(span_id, timestamp)`
/// rows produced by a crash-after-write-before-offset-save are merged into
/// one row at the next part merge. Querying with `FINAL` (or relying on
/// the merge) makes replays invisible to consumers. This is what makes
/// at-least-once delivery safe without a transactional offset commit.
///
/// The instant we accept this contract, we are free to NOT fsync the
/// offset file and to ack-after-success-only. Both choices are deliberate.
async fn flush(
    buf: &mut Vec<Pending>,
    writer: &ClickHouseWriter,
    dlq: &DlqProducer,
    offset_store: &OffsetStore,
    source_topic: &str,
    // The high-water mark including any parse-failed records the caller
    // observed between flushes. We persist max(buf_offset, watermark) so
    // poison records don't get replayed forever.
    watermark: i64,
) {
    if buf.is_empty() {
        // Nothing to write, but persist the watermark if it has advanced
        // (caller already gates this — kept defensive).
        if watermark >= 0 {
            if let Err(e) = offset_store.save(watermark) {
                error!(error = %e, offset = watermark, "failed to persist offset (empty flush)");
            }
        }
        return;
    }

    // Snapshot the max offset before we drain — even on failure we still
    // want to advance past these records (DLQ handles the failed ones).
    let buf_max = buf.iter().map(|p| p.offset).max().unwrap_or(-1);
    let max_offset = buf_max.max(watermark);
    let events: Vec<EnrichedEvent> = buf.drain(..).map(|p| p.event).collect();
    let count = events.len();

    match writer.insert_batch(events.clone()).await {
        Ok(()) => {
            tracing::info!(count, max_offset, "batch written to ClickHouse");
        }
        Err(e) => {
            warn!(
                error = %e,
                count,
                "batch insert failed — falling back to per-event retry"
            );
            // Per-event retry + DLQ. We re-issue single-row inserts here
            // because one poison row can fail a multi-row batch (rare with
            // RMT but possible: e.g. malformed JSON in a JSONString
            // column). Splitting isolates the failure.
            for ev in events {
                write_with_retry(ev, writer, dlq, source_topic, MAX_WRITE_ATTEMPTS).await;
            }
        }
    }

    if max_offset >= 0 {
        if let Err(e) = offset_store.save(max_offset) {
            // Persisting the offset failed — this is recoverable (we'll
            // re-process some events on next restart, RMT will dedupe) but
            // worth shouting about because it means durability is broken
            // for this run.
            error!(error = %e, offset = max_offset, "failed to persist offset");
        }
    }
}
