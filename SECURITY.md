# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| < 0.1.0 | ❌        |

We support the latest release only. Security patches are shipped as patch releases within the timelines below.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@scopecall.com** with:

1. A description of the vulnerability and affected component(s)
2. Steps to reproduce, or a proof-of-concept if available
3. The potential impact and attack surface
4. Your name/handle (for credit if you choose)

### Response SLA

| Severity | Acknowledgement | Patch target |
|----------|----------------|--------------|
| Critical | 48 hours       | 14 days      |
| High     | 48 hours       | 30 days      |
| Medium   | 5 business days | 60 days     |
| Low      | 5 business days | Next release |

We will confirm receipt, triage the report, and keep you informed throughout the process. We do not currently offer a bug bounty program, but we credit researchers in release notes (with your consent).

## Scope

In scope:
- Ingest service (Rust, port 8080)
- API service (Go, port 8081)
- Dashboard (Next.js, port 3000)
- TypeScript SDK (`@scopecall/scopecall-js`)
- Python SDK (`scopecall-sdk`)
- ClickHouse/Postgres/Redpanda configuration shipped in this repo

Out of scope:
- Third-party dependencies (report upstream; notify us if you believe ScopeCall is the attack surface)
- Denial-of-service via resource exhaustion on self-hosted instances
- Issues requiring physical access to the host machine

## Security Architecture Notes

- Auth tokens are JWTs signed with `AUTH_SECRET` — rotate this secret if compromised.
- `INTERNAL_API_KEY` protects the dashboard ↔ API internal channel — never expose it externally.
- ClickHouse default user allows connections from any Docker-internal IP; the `allow_default.xml` config is intentional for self-hosted Docker setups. Do not expose ClickHouse port 9000/8123 to the public internet.
- SDK API keys (`sc_live_*`) are organization-scoped bearer tokens stored hashed in Postgres. Rotate via the dashboard if compromised.

## Disclosure Policy

We follow coordinated disclosure. We ask that you give us the patch timeline above before public disclosure. We will credit you in the release notes unless you prefer to remain anonymous.
