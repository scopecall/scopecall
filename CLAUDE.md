# ScopeCall — Contributor Guide

Source-available, self-hostable AI observability ([BUSL-1.1](LICENSE) — converts to Apache 2.0 on May 26, 2031). This file orients contributors (and AI coding assistants) working in this repo.

## What this is

ScopeCall captures LLM calls via SDK instrumentation (no proxy), ships events through a Rust ingest pipeline to ClickHouse, and serves them via a Go API + Next.js dashboard. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and [README.md](README.md) to get started.

## Repo layout

```
sdks/typescript/        TypeScript SDK (@scopecall/scopecall-js)
sdks/python/            Python SDK (scopecall-python)
services-rust/
  ingest/               HTTP ingest service (port 8080)
  processor/            Kafka consumer → ClickHouse writer
  common/               shared Rust crate
services-go/api/        REST/WebSocket query API (port 8081)
services-dashboard/     Next.js dashboard (port 3000)
schemas/                ClickHouse DDL, OpenAPI spec, pricing, redaction patterns
infra/                  Docker Compose stack, Dockerfiles
docs/                   installation, self-hosting, roadmap
```

## Build & test

> **TypeScript SDK uses pnpm** (run `corepack enable` once). The **Python SDK needs a virtualenv** (macOS system Python blocks global installs).

| Component | Build | Test |
|-----------|-------|------|
| TypeScript SDK | `cd sdks/typescript && pnpm install && pnpm build` | `pnpm test` |
| Python SDK | `cd sdks/python && python3 -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"` | `pytest` |
| Rust services | `cd services-rust && cargo build --workspace` | `cargo test --workspace` |
| Go API | `cd services-go/api && go build ./...` | `go test ./...` |
| Dashboard | `cd services-dashboard && npm install && npm run build` | `npm run build` |
| Full stack | `docker compose -f infra/docker-compose.yml up -d` | send a test event via the SDK |

## Conventions

### Commits

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). A template is configured (`git config commit.template .gitmessage` after clone, or it's set automatically if you clone fresh and run the setup).

```
feat(sdk-ts): add Anthropic instrumentation
fix(ingest): handle empty tool_calls array
chore(deps): bump tokio to 1.40
```

Types: `feat fix perf refactor docs test chore ci`.
Scopes: `sdk-ts sdk-py ingest processor api dashboard schemas infra`.

### Pre-commit hook

A pre-commit hook lives in `.githooks/`. Enable it once after cloning:

```bash
git config core.hooksPath .githooks
```

It keeps commits clean and is fast. If it blocks a commit, read the message — it's almost always pointing at something real.

### Hot path

The ingest → processor → ClickHouse path is Rust and latency-sensitive. Keep it allocation-light. Don't add external runtime dependencies to `services-rust/` without discussion (open an issue first).

### Auth & org isolation

Changes to auth flows, permission checks, or org-isolation logic need a security review. Open an issue before starting.

## Where to contribute

Good areas: SDK instrumentation for new providers (`sdks/*/instrumentation/`), dashboard features, pricing data freshness (`schemas/pricing/`), docs, and bug fixes. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [roadmap](docs/roadmap.md). Open an issue before large features to align with direction.
