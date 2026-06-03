# Installation

ScopeCall self-hosts via Docker Compose. From clone to first trace is about 10 minutes.

## Requirements

- Docker + Docker Compose
- 4 vCPU / 8 GB RAM / 50 GB disk minimum
- An OpenAI API key (for the app you want to observe)

## 1. Start the stack

```bash
git clone https://github.com/scopecall/scopecall.git
cd scopecall

cp infra/.env.example infra/.env
# Generate the two required secrets:
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> infra/.env
echo "INTERNAL_API_KEY=$(openssl rand -hex 32)" >> infra/.env

docker compose -f infra/docker-compose.yml pull
docker compose -f infra/docker-compose.yml up -d
```

Wait for all services to report healthy:

```bash
docker compose -f infra/docker-compose.yml ps
```

## 2. Create your admin account

Open <http://localhost:3000/setup> and create the first org + admin user. This screen only works once — after the first user exists, it redirects to login.

## 3. Generate an API key

In the dashboard, go to **Settings → API Keys → Generate**. Copy the `sc_live_...` key.

## 4. Instrument your app

### TypeScript

```bash
npm install @scopecall/scopecall-js
```

```typescript
import { init } from "@scopecall/scopecall-js";
import OpenAI from "openai";

// init() returns the SDK instance — call once at app startup.
// `endpoint` is the full ingest URL (port 8080 in the docker-compose stack).
const sdk = init({
  apiKey: "sc_live_xxx",
  endpoint: "http://localhost:8080/v1/ingest",
});

const openai = new OpenAI();
sdk.instrument(openai);          // wraps chat.completions.create in place
// All calls through this client are traced automatically
```

### Python

```bash
pip install scopecall-py
# Or with provider extras (recommended):
pip install "scopecall-py[openai]"
pip install "scopecall-py[anthropic]"
```

```python
import scopecall
from openai import OpenAI

sdk = scopecall.init(
    api_key="sc_live_xxx",
    endpoint="http://localhost:8080/v1/ingest",
)

openai_client = sdk.instrument(OpenAI())  # auto-detects async if you pass AsyncOpenAI()

with sdk.trace("my-workflow", user_id="u_1"):
    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Hello"}],
    )
```

Python parity ships in `scopecall-py@0.2.0` alongside the v0.1.1
self-hosted stack: OpenAI + Anthropic sync/async/streaming, workflow
spans, `contextvars`-based trace propagation across `await`, PII
redaction, manual `sdk.record_llm_call(...)` for LangChain / LlamaIndex
/ custom wrappers, and FastAPI lifespan support. Same wire contract as
the TypeScript SDK. Native LangChain / LlamaIndex callback bridges
land in v0.3 — until then, use the manual API.

See [sdks/python/README.md](../sdks/python/README.md) for the full
reference, FastAPI example, and prompt-versioning guide.

## 5. See your traces

Make an LLM call from your app, then open <http://localhost:3000>. Your trace appears within seconds.

## Ports

| Service | Port | Purpose |
|---------|------|---------|
| Dashboard | 3000 | Web UI |
| Ingest | 8080 | SDK sends events here |
| API | 8081 | Internal (dashboard ↔ API) |

Only 3000 and 8080 need to be reachable by you and your app respectively. The rest are internal to the Docker network.

## Next steps

- [Self-hosting guide](self-hosting.md) — production hardening, upgrades, backups
- [Architecture](../ARCHITECTURE.md) — how it all fits together
