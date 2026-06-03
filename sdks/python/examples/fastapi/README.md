# FastAPI + ScopeCall example

A minimal AI backend instrumented with `scopecall`. One `/chat` route
that does either a single-shot or streaming OpenAI completion, traced
as a workflow span with parent-span chaining.

## What it shows

- SDK lifecycle bound to FastAPI's `lifespan` (init at startup, close
  at shutdown so pending events drain before the process exits).
- `sdk.instrument(AsyncOpenAI())` — async client wrapping is
  auto-detected; no separate API.
- `with sdk.trace("chat-api", user_id=..., session_id=...):` around
  the route body — the LLM event hangs off the workflow span.
- Streaming via FastAPI `StreamingResponse`, with TTFT and final token
  counts still captured on the ScopeCall side.
- `default_prompt_version=DEPLOY_SHA` env-based tagging.

## Run

```bash
# 1. Install dependencies.
pip install "scopecall-py[openai]" fastapi uvicorn

# 2. Bring up the ScopeCall stack (from the repo root, not this dir).
cd ../../..; docker compose -f infra/docker-compose.yml up -d
# Generate an API key at http://localhost:3000/dashboard/settings/keys
# and copy it.

# 3. Run the example.
cd sdks/python/examples/fastapi
export SCOPECALL_API_KEY=sc_live_xxx
export OPENAI_API_KEY=sk-...
uvicorn app:app --reload --port 8000
```

## Test

```bash
# Single-shot
curl -s -X POST http://localhost:8000/chat \
  -H 'content-type: application/json' \
  -d '{
        "user_id": "u_1",
        "messages": [{"role":"user","content":"What is 2+2?"}]
      }' | jq

# Streaming (note --no-buffer so curl prints chunks as they arrive)
curl -sN -X POST http://localhost:8000/chat \
  -H 'content-type: application/json' \
  -d '{
        "user_id": "u_1",
        "stream": true,
        "messages": [{"role":"user","content":"Write a haiku about traces."}]
      }'
```

Within ~5 seconds, the ScopeCall dashboard at http://localhost:3000
shows a `chat-api` workflow node in the trace tree with the
`gpt-4o-mini` call as its child. The Prompts page surfaces aggregate
metrics by `DEPLOY_SHA` when that env var is set.
