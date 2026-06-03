# ── Stage 1: Build ────────────────────────────────────────────────────────────
# Build from the workspace root (docker-compose context: ./services-rust)
FROM rust:1.88-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Copy workspace manifests for dependency layer caching
COPY Cargo.toml Cargo.lock ./
COPY common/Cargo.toml common/
COPY ingest/Cargo.toml ingest/
COPY processor/Cargo.toml processor/

# Stub sources — lets cargo fetch + compile deps before real source arrives
RUN mkdir -p common/src ingest/src processor/src && \
    echo "pub fn _stub() {}" > common/src/lib.rs && \
    echo "fn main() {}" > ingest/src/main.rs && \
    echo "fn main() {}" > processor/src/main.rs && \
    # Added [lib] target to processor — lib.rs must exist for workspace build
    echo "pub fn _stub() {}" > processor/src/lib.rs && \
    cargo build --release --bin ingest && \
    # Remove stub-compiled artifacts so the real build recompiles from source.
    # Must remove both the binary, the rlibs (lib-prefix), and the entire
    # fingerprint dirs (not just invoked.timestamp) to force cargo to rebuild.
    rm -f  target/release/ingest && \
    rm -rf target/release/.fingerprint/ingest-* \
           target/release/.fingerprint/common-* \
           target/release/.fingerprint/processor-* && \
    find target/release/deps -name 'libcommon-*'   -delete && \
    find target/release/deps -name 'libingest-*'   -delete && \
    find target/release/deps -name 'libprocessor-* ' -delete && \
    find target/release/deps -name 'ingest-*'      -delete

# Copy real source trees
COPY common/src/ common/src/
COPY ingest/src/ ingest/src/

RUN cargo build --release --bin ingest

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# distroless/cc: glibc + libgcc; ~15 MB; supports executables that link OpenSSL
# :debug variant adds busybox (~2 MB) — required for compose/k8s healthchecks
# (provides /bin/sh and wget; remove :debug tag to harden further in prod)
FROM gcr.io/distroless/cc-debian12:debug

COPY --from=builder /workspace/target/release/ingest /ingest

EXPOSE 8080

ENTRYPOINT ["/ingest"]
