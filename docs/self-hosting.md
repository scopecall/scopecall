# Self-Hosting Guide

Self-hosting is a first-class target. The Docker Compose stack in this repo is the same software that runs in ScopeCall Cloud — no feature gating.

For the initial install, see [installation.md](installation.md). This guide covers production concerns.

## Environment variables

Set these in `infra/.env`. See `infra/.env.example` for the full template.

| Variable | Required | Purpose |
|----------|----------|---------|
| `AUTH_SECRET` | ✅ | Signs Auth.js JWTs. 32+ random bytes. Generate: `openssl rand -hex 32` |
| `INTERNAL_API_KEY` | ✅ | Shared secret for the dashboard ↔ API internal channel. Generate: `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | optional | Defaults to `scopecall`. **Change for production.** |
| `SCOPECALL_VERSION` | optional | Image tag. Defaults to `latest`. **Pin to a version in production.** |

Both required secrets are enforced at startup — the stack will refuse to boot if they're unset.

## Pinning versions

Always pin `SCOPECALL_VERSION` in production so deployments are reproducible:

```bash
echo "SCOPECALL_VERSION=v0.1.1" >> infra/.env
```

## Upgrading

```bash
# Update the version pin in infra/.env, then:
docker compose -f infra/docker-compose.yml pull
docker compose -f infra/docker-compose.yml up -d
```

Schema migrations run automatically on startup. ClickHouse and Postgres migrations are forward-only and idempotent. **Back up your volumes before a major version upgrade** (see below).

## Backups

State lives in four named Docker volumes:

| Volume | Contains |
|--------|----------|
| `clickhouse-data` | Trace events, cost data (the bulk of your data) |
| `postgres-data` | Users, orgs, API keys, config |
| `redpanda-data` | In-flight event buffer (transient) |
| `redis-data` | Caches (transient) |

The two that matter for backup are `clickhouse-data` and `postgres-data`.

```bash
# Example: back up Postgres
docker compose -f infra/docker-compose.yml exec postgres \
  pg_dump -U scopecall scopecall > backup-postgres-$(date +%F).sql

# ClickHouse: use clickhouse-backup or volume snapshots for large datasets
```

## Reverse proxy + TLS

The stack serves HTTP on port 3000 by default. For production, front it with a reverse proxy that terminates TLS (Caddy, nginx, or your cloud load balancer). Do not expose ClickHouse (8123/9000) or Postgres (5432) to the public internet — they are intended for the internal Docker network only.

## Resource sizing

| Scale | Guidance |
|-------|----------|
| Getting started | 4 vCPU / 8 GB / 50 GB (the documented minimum) |
| ~1M events/day | 8 vCPU / 16 GB / 200 GB SSD |
| Higher | ClickHouse is the bottleneck — scale disk + RAM first; the Rust ingest path handles high throughput on modest CPU |

## Data retention

Trace events in ClickHouse have a default 90-day TTL. Adjust the TTL in the ClickHouse schema if you need longer retention (and size disk accordingly).

## Health checks

Every service exposes a health endpoint and Compose health checks gate startup order. Check status with:

```bash
docker compose -f infra/docker-compose.yml ps
```

All services should show `healthy`. If one is stuck, check its logs:

```bash
docker compose -f infra/docker-compose.yml logs <service>
```

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Stack refuses to start | `AUTH_SECRET` or `INTERNAL_API_KEY` unset in `infra/.env` |
| `/setup` redirects to login | An admin user already exists — setup is one-time |
| Dashboard shows no traces | SDK `endpoint` not pointing at your ingest URL (port 8080, full path `/v1/ingest`), or API key invalid |
| Events accepted but not visible | Check processor logs; ClickHouse may be unhealthy |

For security disclosure, see [SECURITY.md](../SECURITY.md).
