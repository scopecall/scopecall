"""FastAPI example — observed AI backend with ScopeCall.

This is the smallest realistic shape of a production AI app:

  - A single FastAPI route accepts a user question + optional session id.
  - The handler wraps the LLM call in `sdk.trace("chat-api")` so it
    shows up in the ScopeCall dashboard as a workflow span with the
    `chat.completions.create` call as its child.
  - Streaming returns chunks to the client as they arrive (FastAPI
    StreamingResponse) while still capturing the full completion + TTFT
    on the ScopeCall side.
  - SDK lifecycle is bound to the FastAPI lifespan: `init()` at
    startup, `close()` on shutdown so the background flush thread
    drains pending events before the process exits.

Run it:

    pip install scopecall[openai] fastapi uvicorn
    export SCOPECALL_API_KEY=sc_live_xxx
    export OPENAI_API_KEY=sk-...                 # for the real OpenAI call
    uvicorn app:app --reload --port 8000

Then in another terminal:

    curl -sN -X POST http://localhost:8000/chat \\
      -H 'content-type: application/json' \\
      -d '{"user_id": "u_1", "messages": [{"role":"user","content":"hi"}]}'

The dashboard at http://localhost:3000 will show a `chat-api` workflow
node within ~5 seconds, with the `gpt-4o-mini` call hanging off it as
the child LLM span.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel

import scopecall

# Module-level handles, populated by `lifespan`. `cast`-like — typed as
# the real types so route handlers below get autocomplete; the values
# are assigned before any route runs because lifespan runs first.
sdk: scopecall.ScopeCallSDK
openai_client: AsyncOpenAI


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """SDK lifecycle bound to the app's lifespan.

    Why not module-level init: tying init/close to lifespan means we
    flush pending events on graceful shutdown (SIGTERM under uvicorn,
    container stop) before the worker process exits. atexit also covers
    this for hard exits, but lifespan is the precise hook.
    """
    global sdk, openai_client

    sdk = scopecall.init(
        api_key=os.environ["SCOPECALL_API_KEY"],
        # `endpoint` is required — point at your ingest. The example
        # defaults to localhost so `docker compose up` from the repo
        # root makes this work out of the box.
        endpoint=os.environ.get(
            "SCOPECALL_ENDPOINT", "http://localhost:8080/v1/ingest"
        ),
        environment=os.environ.get("ENV", "development"),
        # Tag every trace with the deploy SHA when present — the Prompts
        # page can then show "did v7 spike output tokens?" without
        # per-handler tagging.
        default_prompt_version=os.environ.get("DEPLOY_SHA"),
    )

    # AsyncOpenAI auto-detected by `sdk.instrument` — it sees that
    # chat.completions.create is a coroutine function and installs the
    # async wrapper.
    openai_client = sdk.instrument(AsyncOpenAI())

    yield

    # Shutdown: flush + stop the background thread. 5s is plenty for a
    # well-behaved app; longer timeouts mostly just delay the SIGTERM
    # → process-exit window without improving delivery.
    sdk.close(timeout=5.0)


app = FastAPI(lifespan=lifespan)


# ─── Request schema ─────────────────────────────────────────────────


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    user_id: str
    session_id: str | None = None
    messages: list[Message]
    # Setting `stream=False` here matches OpenAI's API shape so the
    # caller's mental model is the same.
    stream: bool = False


# ─── Routes ──────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict[str, str]:
    """Cheap liveness probe. No SDK calls — k8s should be able to hit
    this even when ScopeCall is unreachable."""
    return {"status": "ok"}


@app.post("/chat")
async def chat(req: ChatRequest):
    """Single-shot or streaming chat completion, traced as a workflow.

    Two paths:
      - stream=False: returns one JSON response with the full reply.
      - stream=True:  returns a server-sent-events-ish stream of chunks
                      via FastAPI StreamingResponse.

    Both paths emit exactly one workflow event + one LLM event to
    ScopeCall, with parent-span chaining. The LLM event has TTFT
    populated when streaming.

    Critical detail (Round-12 review P0b): for the streaming path, the
    `sdk.trace()` block must wrap the stream-consumption loop, NOT
    just the call to `create()`. If the trace block exits before the
    StreamingResponse iterator runs, the workflow span's `latency_ms`
    only measures stream creation (a few ms), and — if the SDK is
    relying on `contextvars.get_current()` at emit time — the child
    LLM event becomes orphan. We pull the streaming case out into its
    own helper so the structure is obvious, and we use `sdk.trace()`
    INSIDE the event_source generator.
    """
    # Pydantic models → plain dicts for the OpenAI client. The SDK's
    # input_text extractor expects role/content dicts.
    messages = [m.model_dump() for m in req.messages]

    if not req.stream:
        # Non-streaming: trace block wraps the await — workflow latency
        # = full request latency, LLM event chains correctly.
        with sdk.trace(
            "chat-api",
            user_id=req.user_id,
            session_id=req.session_id,
            feature_name="chat",
        ):
            response = await openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=messages,
            )
            return {
                "reply": response.choices[0].message.content,
                "model": response.model,
                "finish_reason": response.choices[0].finish_reason,
                "usage": {
                    "input_tokens": response.usage.prompt_tokens,
                    "output_tokens": response.usage.completion_tokens,
                },
            }

    # Streaming: keep the trace open across the whole iteration so
    # workflow latency measures the full client-perceived duration.
    # FastAPI's StreamingResponse calls the iterator AFTER this handler
    # returns, so the trace block has to live inside the generator —
    # not around the call to .create() the way one would naturally
    # write it.
    async def event_source() -> AsyncIterator[bytes]:
        with sdk.trace(
            "chat-api",
            user_id=req.user_id,
            session_id=req.session_id,
            feature_name="chat",
        ):
            stream = await openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=messages,
                stream=True,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    # Mimic SSE framing so curl --no-buffer renders
                    # incremental output. Production should use proper
                    # SSE / WebSocket framing.
                    yield f"data: {delta}\n\n".encode()
            yield b"data: [DONE]\n\n"

    return StreamingResponse(event_source(), media_type="text/event-stream")
