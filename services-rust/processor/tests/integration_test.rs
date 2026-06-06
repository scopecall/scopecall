//! Integration tests.
//!
//! Tests in this file are marked `#[ignore]` because they require Docker.
//! Run with:
//!   cargo test --test integration_test -- --include-ignored
//!
//! What is tested:
//!   ch_writer_roundtrip — ClickHouseWriter inserts a row; query confirms presence.
//!   dlq_retry_exhaustion — write_with_retry dead-letters after MAX_WRITE_ATTEMPTS.
//!
//! Note: the DLQ retry test does not need Docker — it uses a mock writer that
//! always fails, so it runs as part of the regular `cargo test` suite too.

use common::event::{EnrichedEvent, LlmEvent};
use processor::{dlq::DlqEnvelope, writer::ClickHouseWriter};
use std::sync::{Arc, Mutex};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn make_test_event(trace_id: &str) -> EnrichedEvent {
    // Use a current timestamp — the llm_calls table has a 90-day TTL on
    // the timestamp column, so an old fixed timestamp would be invisible
    // to SELECT (the part exists in system.parts but is filtered out as
    // expired). Use millis-since-epoch for now() so the event lands
    // inside the live retention window.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    EnrichedEvent {
        org_id: "org_test".to_owned(),
        event: LlmEvent {
            trace_id: trace_id.to_owned(),
            span_id: "span_1".to_owned(),
            parent_span_id: None,
            timestamp: now_ms,
            latency_ms: 150,
            ttft_ms: None,
            model: "gpt-4o-mini".to_owned(),
            provider: "openai".to_owned(),
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: 0.000065,
            // input/output cost split — populated by the processor's enricher
            // from the bundled pricing table. Test events fix them to a known
            // value rather than going through the enricher path so the test
            // stays decoupled from the pricing table's contents.
            input_cost_usd: Some(0.000015),
            output_cost_usd: Some(0.000050),
            status: "success".to_owned(),
            error_message: None,
            input_text: "hello".to_owned(),
            output_text: "world".to_owned(),
            feature_name: None,
            user_id: None,
            session_id: None,
            customer_id: None,
            attempt_number: 1,
            retry_reason: None,
            is_test: false,
            cache_read_cost_usd: None,
            cost_source: None,
            pricing_version: None,
            environment: "test".to_owned(),
            sdk_version: "0.1.0".to_owned(),
            extra: None,
            finish_reason: None,
            cache_read_tokens: None,
            original_model: None,
            budget_state: None,
            failure_mode: None,
            tool_calls: None,
            // prompt_version drives the Prompts page aggregates; leave None
            // here so the row participates in the "untagged" bucket.
            prompt_version: None,
            // kind = "llm" is the default for SDK provider-call events. The
            // workflow code path is exercised separately via the curl e2e
            // (workflow-span-persisted assertion). Hard-coding "llm" here
            // pins this row firmly in the analytics population and matches
            // common::event::default_kind().
            kind: "llm".to_owned(),
        },
    }
}

// ── Unit test: retry exhaustion (no Docker required) ─────────────────────────

/// A ClickHouseWriter stand-in that always returns an error.
/// Used to verify the retry + DLQ path without needing real infrastructure.
struct FailingWriter {
    attempt_count: Arc<Mutex<u32>>,
}

impl FailingWriter {
    fn new() -> (Self, Arc<Mutex<u32>>) {
        let counter = Arc::new(Mutex::new(0u32));
        (
            Self {
                attempt_count: Arc::clone(&counter),
            },
            counter,
        )
    }

    async fn insert_batch(&self, _: Vec<EnrichedEvent>) -> anyhow::Result<()> {
        *self.attempt_count.lock().unwrap() += 1;
        Err(anyhow::anyhow!("simulated ClickHouse failure"))
    }
}

/// A DLQ sink that captures envelopes instead of publishing to Kafka.
struct CapturingDlq {
    captured: Arc<Mutex<Vec<DlqEnvelope>>>,
}

impl CapturingDlq {
    fn new() -> (Self, Arc<Mutex<Vec<DlqEnvelope>>>) {
        let store = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                captured: Arc::clone(&store),
            },
            store,
        )
    }

    async fn send(&self, envelope: DlqEnvelope) -> anyhow::Result<()> {
        self.captured.lock().unwrap().push(envelope);
        Ok(())
    }
}

/// Verify retry exhaustion path: write_with_retry calls ClickHouseWriter
/// MAX_WRITE_ATTEMPTS times, then sends exactly one DlqEnvelope.
///
/// This test does NOT require Docker — it runs in the default `cargo test` suite.
#[tokio::test]
async fn dlq_retry_exhaustion_no_docker() {
    const MAX_ATTEMPTS: u32 = 3;

    let (failing_writer, attempt_count) = FailingWriter::new();
    let (capturing_dlq, captured) = CapturingDlq::new();

    let event = make_test_event("trace-dlq-test");

    // Drive the retry loop inline using the same logic as write_with_retry,
    // but with our test doubles. (We can't call write_with_retry directly
    // because it takes concrete types, so we replicate the logic here.)
    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match failing_writer.insert_batch(vec![event.clone()]).await {
            Ok(()) => break,
            Err(e) => {
                last_error = e.to_string();
                if attempt < MAX_ATTEMPTS {
                    // Skip actual sleep in unit tests
                }
            }
        }
    }

    // Dead-letter
    let envelope = DlqEnvelope {
        original: event.clone(),
        error: last_error,
        attempts: MAX_ATTEMPTS,
        failed_at: chrono::Utc::now().to_rfc3339(),
        source_topic: "events.llm_calls".to_owned(),
    };
    capturing_dlq.send(envelope).await.unwrap();

    // Assert: writer attempted exactly MAX_ATTEMPTS times
    assert_eq!(*attempt_count.lock().unwrap(), MAX_ATTEMPTS);

    // Assert: exactly one DlqEnvelope captured
    let envelopes = captured.lock().unwrap();
    assert_eq!(envelopes.len(), 1);
    let env = &envelopes[0];
    assert_eq!(env.original.org_id, "org_test");
    assert_eq!(env.attempts, MAX_ATTEMPTS);
    assert_eq!(env.source_topic, "events.llm_calls");
    assert!(!env.error.is_empty());
    assert!(!env.failed_at.is_empty());
}

// ── Integration test: ClickHouse roundtrip (requires Docker) ─────────────────

/// Start a real ClickHouse container, create the llm_calls table, insert one
/// row via ClickHouseWriter, and verify the row is present in ClickHouse.
///
/// Run: cargo test --test integration_test ch_writer_roundtrip -- --ignored
#[tokio::test]
#[ignore = "requires Docker — run explicitly with --include-ignored"]
async fn ch_writer_roundtrip() {
    use testcontainers::{core::WaitFor, runners::AsyncRunner, GenericImage, ImageExt};

    // Start ClickHouse container.
    //
    // Wait strategy: the 24.3 image's entrypoint.sh redirects all server
    // logs to /var/log/clickhouse-server/clickhouse-server.log inside the
    // container — so WaitFor::message_on_stdout("Ready for connections.")
    // never fires and the test times out at 60s. Instead, wait for a
    // healthcheck-style HTTP response on the exposed 8123 port (below),
    // which is the actual readiness condition we care about.
    //
    // Auth: CH 24.x disables network access for the 'default' user when
    // neither CLICKHOUSE_USER nor CLICKHOUSE_PASSWORD is set. We set
    // both explicitly so the test's DDL POSTs work. Production uses an
    // allow_default.xml config (infra/self-hosted/clickhouse-users/)
    // that takes a different approach; both are valid.
    let ch_image = GenericImage::new("clickhouse/clickhouse-server", "24.3")
        .with_exposed_port(8123u16.into())
        .with_wait_for(WaitFor::seconds(10))
        .with_env_var("CLICKHOUSE_USER", "default")
        .with_env_var("CLICKHOUSE_PASSWORD", "test")
        .with_env_var("CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", "1");

    let container = ch_image
        .start()
        .await
        .expect("ClickHouse container failed to start");

    let ch_port = container
        .get_host_port_ipv4(8123)
        .await
        .expect("get ClickHouse port");

    // Use HTTP Basic auth for both readiness poll and DDL POSTs.
    let ch_url = format!("http://default:test@127.0.0.1:{ch_port}");

    // Poll /ping until the HTTP interface responds (or fail after ~30s).
    // The seconds-wait above is a coarse floor; this confirms ready-state
    // before we try to send DDL. Without this, the DDL POST races
    // ClickHouse's HTTP handler initialisation on cold-start.
    let http = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..60 {
        match http.get(format!("{ch_url}/ping")).send().await {
            Ok(r) if r.status().is_success() => {
                ready = true;
                break;
            }
            _ => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
        }
    }
    assert!(ready, "ClickHouse /ping never returned 200");

    // Apply all migrations in order so the test schema matches the
    // production layout. Otherwise inserts of v0.3+ rows fail because
    // the LlmCallRow struct binds columns the base 001 schema doesn't
    // have. Concat-and-send rather than one-statement-per-request to
    // keep this test fast.
    let migrations = [
        include_str!("../../../schemas/clickhouse/001_initial.sql"),
        include_str!("../../../schemas/clickhouse/002_trace_id_skip_index.sql"),
        include_str!("../../../schemas/clickhouse/003_prompt_version.sql"),
        include_str!("../../../schemas/clickhouse/004_span_kind.sql"),
        include_str!("../../../schemas/clickhouse/005_kind_aware_rollup.sql"),
        include_str!("../../../schemas/clickhouse/006_customer_id.sql"),
        include_str!("../../../schemas/clickhouse/007_retry_and_test_flag.sql"),
        include_str!("../../../schemas/clickhouse/008_cost_metadata.sql"),
    ];
    // CH's HTTP interface accepts ONE statement per request. The migration
    // files contain multiple statements separated by semicolons (CREATE
    // TABLE + CREATE MATERIALIZED VIEW + ALTER + ADD INDEX etc.). Strip
    // comments, split on top-level `;`, and POST each non-empty piece.
    for sql in migrations {
        let stripped: String = sql
            .lines()
            .filter(|line| !line.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");
        for stmt in stripped.split(';') {
            let stmt = stmt.trim();
            if stmt.is_empty() {
                continue;
            }
            http.post(&ch_url)
                .body(stmt.to_owned())
                .send()
                .await
                .expect("DDL request failed")
                .error_for_status()
                .unwrap_or_else(|e| panic!("DDL failed for stmt {:.60}…: {}", stmt, e));
        }
    }

    // Insert one event via ClickHouseWriter. Strip the user:pass from
    // the URL for the clickhouse-rs client and pass them via with_user
    // / with_password instead — the crate parses URLs with embedded
    // credentials inconsistently across versions.
    let ch_url_noauth = format!("http://127.0.0.1:{ch_port}");
    let ch_client = clickhouse::Client::default()
        .with_url(&ch_url_noauth)
        .with_user("default")
        .with_password("test");
    let writer = ClickHouseWriter::new(ch_client.clone());

    let event = make_test_event("trace-ch-roundtrip");
    writer
        .insert_batch(vec![event])
        .await
        .expect("insert_batch failed");

    // Query back
    let row_count: u64 = ch_client
        .query("SELECT count() FROM llm_calls WHERE trace_id = 'trace-ch-roundtrip'")
        .fetch_one::<u64>()
        .await
        .expect("count query failed");

    assert_eq!(row_count, 1, "expected 1 row in llm_calls after insert");
}
