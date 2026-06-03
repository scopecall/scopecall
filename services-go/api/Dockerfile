# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM golang:1.26-bookworm AS builder

WORKDIR /workspace

# Copy go.work so module replacements resolve inside the image
COPY go.work go.work.sum ./

# Dependency layer: copy module files before source so cache invalidates
# only when dependencies change
COPY api/go.mod api/go.sum api/
COPY common/go.mod common/go.sum common/
# go.work references tools/dlq-drain — module files must exist for go mod download
COPY tools/dlq-drain/go.mod tools/dlq-drain/go.sum tools/dlq-drain/
RUN cd api && go mod download

# Copy source
COPY api/ api/
COPY common/ common/

# CGO disabled → fully static binary; no libc dependency at runtime
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -extldflags '-static'" \
    -o /out/api \
    ./api/cmd/api

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# distroless/static: no libc — smallest possible attack surface
# :debug variant adds busybox (~2 MB) — required for compose/k8s healthchecks
# (provides /bin/sh and wget; remove :debug tag to harden further in prod)
FROM gcr.io/distroless/static-debian12:debug

COPY --from=builder /out/api /api

EXPOSE 8081

ENTRYPOINT ["/api"]
