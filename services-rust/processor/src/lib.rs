//! Processor library — exposes modules for integration testing.
//!
//! The deployed artifact is the `processor` binary (`src/main.rs`).
//! This lib target exists so that `tests/integration_test.rs` can
//! import `processor::writer::ClickHouseWriter` etc. without duplicating code.

pub mod consumer;
pub mod dlq;
pub mod enricher;
pub mod offset_store;
pub mod pricing;
pub mod writer;
