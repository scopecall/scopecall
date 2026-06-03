# ── Stage 1: Build ────────────────────────────────────────────────────────────
# Build context must be the REPO ROOT (not services-rust/) so that
# include_str!("../../../schemas/redaction/patterns.yaml") in enricher.rs
# resolves correctly.  Path math:
#   WORKDIR = /workspace/services-rust
#   source  = /workspace/services-rust/processor/src/enricher.rs
#   ../../../ → /workspace/   (3 levels: src → processor → services-rust → workspace)
#   → /workspace/schemas/redaction/patterns.yaml  ✓
FROM rust:1.88-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

# Schemas land at /workspace/schemas/ — one level above the cargo workspace root.
# Both directories are embedded into the binary via include_str!:
#   - redaction/patterns.yaml  → enricher.rs (PII regex set)
#   - pricing/pricing.json     → pricing.rs  (server-authoritative cost table)
# Missing either causes the build to fail with "couldn't read ... No such file".
WORKDIR /workspace
COPY schemas/redaction/ schemas/redaction/
COPY schemas/pricing/   schemas/pricing/

# Cargo workspace lives at /workspace/services-rust/
WORKDIR /workspace/services-rust

COPY services-rust/Cargo.toml services-rust/Cargo.lock ./
COPY services-rust/common/Cargo.toml    common/
COPY services-rust/ingest/Cargo.toml    ingest/
COPY services-rust/processor/Cargo.toml processor/

RUN mkdir -p common/src ingest/src processor/src && \
    echo "pub fn _stub() {}" > common/src/lib.rs && \
    echo "fn main() {}" > ingest/src/main.rs && \
    echo "fn main() {}" > processor/src/main.rs && \
    # Added [lib] target — lib.rs must exist for the stub dep-layer build
    echo "pub fn _stub() {}" > processor/src/lib.rs && \
    cargo build --release --bin processor && \
    # Remove stub-compiled artifacts so the real build recompiles from source.
    rm -f  target/release/processor && \
    rm -rf target/release/.fingerprint/processor-* \
           target/release/.fingerprint/common-* \
           target/release/.fingerprint/ingest-* && \
    find target/release/deps -name 'libcommon-*'    -delete && \
    find target/release/deps -name 'libprocessor-*' -delete && \
    find target/release/deps -name 'processor-*'    -delete

COPY services-rust/common/src/    common/src/
COPY services-rust/processor/src/ processor/src/

RUN cargo build --release --bin processor

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# :debug adds busybox (~2 MB) for healthcheck support; parity with ingest image
FROM gcr.io/distroless/cc-debian12:debug

COPY --from=builder /workspace/services-rust/target/release/processor /processor

# Processor has no inbound port — it consumes from Redpanda, writes to ClickHouse
ENTRYPOINT ["/processor"]
