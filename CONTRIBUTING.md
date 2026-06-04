# Contributing to ScopeCall

Thank you for your interest in contributing. ScopeCall is licensed under [Apache 2.0](LICENSE) — contributions are welcome, you retain copyright, and your contributions are licensed under the same terms.

No CLA required.

---

## Prerequisites

- **Docker** + Docker Compose
- **Node 20+** with **pnpm** — the TypeScript SDK uses pnpm (run `corepack enable` to activate it; it ships with Node)
- **Rust** — install via [rustup](https://rustup.rs)
- **Go 1.22+**
- **Python 3.10+** (for the Python SDK)

## Getting Started

```bash
# 1. Clone and enter the repo
git clone https://github.com/scopecall/scopecall.git
cd scopecall

# 2. Start infrastructure
cp infra/.env.example infra/.env  # fill in AUTH_SECRET and INTERNAL_API_KEY
docker compose -f infra/docker-compose.yml up -d

# 3. TypeScript SDK (uses pnpm — `npm install` will fail here)
corepack enable                            # one-time: activates pnpm
cd sdks/typescript && pnpm install && cd ../..

# 4. Dashboard
cd services-dashboard && npm install && cd ..

# 5. Python SDK (use a virtualenv — macOS system Python blocks global installs)
cd sdks/python
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
deactivate && cd ..

# 6. Rust services
cd services-rust && cargo build && cd ..

# 7. Go API
cd services-go/api && go build ./... && cd ../..
```

---

## Branch Naming

| Purpose | Pattern |
|---------|---------|
| Feature | `feat/<short-description>` |
| Bug fix | `fix/<short-description>` |
| Documentation | `docs/<short-description>` |
| Refactor | `refactor/<short-description>` |
| Tests | `test/<short-description>` |

---

## Workflow

1. **Fork** the repo and create your branch from `main`.
2. **Make your changes** — see the architecture notes below for which services to touch.
3. **Test** — run the relevant test commands before opening a PR.
4. **Open a PR** against `main` — small, focused PRs are much easier to review.
5. **Describe** what you changed and why in the PR body.

---

## Testing

| Component | Command |
|-----------|---------|
| TypeScript SDK | `cd sdks/typescript && pnpm test` |
| Python SDK | `cd sdks/python && source .venv/bin/activate && pytest` |
| Rust services | `cd services-rust && cargo test --workspace` |
| Go API | `cd services-go/api && go test ./...` |
| Dashboard | `cd services-dashboard && npm run build` |
| Full stack (smoke test) | `docker compose -f infra/docker-compose.yml up -d` — then send a test event via the SDK |

All PRs should pass the relevant tests. CI runs type-check, lint, and unit tests automatically.

---

## Architecture at a Glance

```
sdks/typescript/        — TypeScript SDK (@scopecall/scopecall-js)
sdks/python/            — Python SDK (scopecall-sdk)
services-rust/
  ingest/               — Rust HTTP ingest service (port 8080)
  processor/            — Rust Kafka consumer → ClickHouse writer
  common/               — Shared Rust types (event.rs, config.rs)
services-go/
  api/                  — Go REST/WebSocket API (port 8081)
services-dashboard/     — Next.js dashboard (port 3000)
schemas/
  clickhouse/           — ClickHouse DDL (source of truth)
  redaction/            — PII pattern config for the enricher
infra/                  — Docker Compose stack, self-hosted config
```

**Hot path** (ingest → Redpanda → processor → ClickHouse) is Rust only. Keep it allocation-light and latency-sensitive.

**API and dashboard** are Go and TypeScript respectively — standard patterns apply.

---

## What to Contribute

Great areas for community contributions:

- **SDK instrumentation** — Anthropic, Gemini, Mistral, Cohere (see `sdks/typescript/src/instrumentation/`)
- **Dashboard features** — new chart types, filter UX, cost breakdown views
- **Pricing data** — keeping `schemas/pricing/` up to date as model prices change
- **Documentation** — clarifications, examples, how-tos
- **Bug fixes** — anything with a `bug` label in GitHub Issues

Please **open an issue** before starting large new features — this avoids duplicate work and ensures alignment with the roadmap.

---

## What We Won't Merge

- Changes that break the hot-path performance contract (introduce allocations in the ingest critical path without justification)
- New external runtime dependencies in `services-rust/` without prior discussion
- Any changes to auth flows, permission checks, or org-isolation logic without a security review (open an issue first)

---

## Community Plugins (Future)

Agent observability plugins, custom enrichers, and platform integrations will eventually be publishable as community packages. The plugin interface is not stable yet — watch the [roadmap](docs/roadmap.md) for the upcoming plugin SDK.

---

## Code of Conduct

Be kind. We are building something real and want a community that reflects that. Harassment of any kind will result in an immediate ban.

Questions? Join the discussion in [GitHub Discussions](https://github.com/scopecall/scopecall/discussions) or email founders@scopecall.com.
