"""Streaming + trace-context propagation tests.

Round-12 review P0b: streaming wrappers used to call
`_context.get_current()` at EMIT time (when the stream completes),
not at CREATE time (when `client.chat.completions.create()` is
called). That meant any stream consumed AFTER the enclosing
`sdk.trace()` block exited became orphan — `parent_span_id=None`,
new `trace_id`, no link to the workflow span.

This was the failure mode in the included FastAPI streaming example
(StreamingResponse runs the iterator after the route handler returns).

These tests pin the contract: even when the stream is iterated AFTER
the trace block has exited, the emitted LLM event MUST have
parent_span_id == the trace's span_id, and the same trace_id.

Covers both providers and both sync + async paths.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import scopecall


def _read_events(path: str) -> list[dict[str, Any]]:
    time.sleep(0.5)
    p = Path(path)
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


# ─── Fakes (kept inline so each test is self-contained) ─────────────


class _FakeOpenAIClient:
    def __init__(self, create_fn):
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=create_fn),
        )


class _FakeAnthropicClient:
    def __init__(self, create_fn):
        self.messages = SimpleNamespace(create=create_fn)


def _openai_chunk(
    delta_content: str | None = None,
    finish_reason: str | None = None,
    usage: SimpleNamespace | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        model="gpt-4o-mini",
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=delta_content),
                finish_reason=finish_reason,
            )
        ],
        usage=usage,
    )


# ─── OpenAI: sync stream consumed after trace exits ─────────────────


class TestOpenAIStreamingContextSync:
    def test_stream_consumed_after_trace_exits_still_chains(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            def gen():
                yield _openai_chunk(delta_content="Hello")
                yield _openai_chunk(delta_content=" world")
                yield _openai_chunk(delta_content=None, finish_reason="stop")
                yield _openai_chunk(
                    delta_content=None,
                    usage=SimpleNamespace(prompt_tokens=5, completion_tokens=8),
                )

            return gen()

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(_FakeOpenAIClient(fake_create))
            captured_span_id: str | None = None
            captured_trace_id: str | None = None

            # Create stream INSIDE the trace block...
            with sdk.trace("workflow-stream") as ctx:
                captured_span_id = ctx.span_id
                captured_trace_id = ctx.trace_id
                stream = client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": "hi"}],
                    stream=True,
                )
            # ...but consume it AFTER the block has exited. This is the
            # critical Round-12 case — without ctx_snapshot, the LLM
            # event becomes orphan here.
            collected = []
            for chunk in stream:
                if chunk.choices[0].delta.content:
                    collected.append(chunk.choices[0].delta.content)
            assert "".join(collected) == "Hello world"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 2
        llm = next(e for e in events if e["kind"] == "llm")
        wf = next(e for e in events if e["kind"] == "workflow")
        # The headline assertions from the reviewer's P0b spec:
        assert llm["trace_id"] == wf["trace_id"]
        assert llm["trace_id"] == captured_trace_id
        assert llm["parent_span_id"] == wf["span_id"]
        assert llm["parent_span_id"] == captured_span_id


# ─── OpenAI: async stream consumed after trace exits ────────────────


class TestOpenAIStreamingContextAsync:
    async def test_async_stream_consumed_after_trace_exits_still_chains(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        async def fake_create_async(**kwargs):
            async def agen():
                yield _openai_chunk(delta_content="Hi ")
                yield _openai_chunk(delta_content="there")
                yield _openai_chunk(delta_content=None, finish_reason="stop")
                yield _openai_chunk(
                    delta_content=None,
                    usage=SimpleNamespace(prompt_tokens=5, completion_tokens=8),
                )

            return agen()

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            client = sdk.instrument(_FakeOpenAIClient(fake_create_async))
            ws_span_id: str | None = None

            with sdk.trace("async-workflow") as ctx:
                ws_span_id = ctx.span_id
                stream = await client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": "go"}],
                    stream=True,
                )
            # Consume async-iterate the stream OUTSIDE the trace block.
            text = []
            async for chunk in stream:
                if chunk.choices[0].delta.content:
                    text.append(chunk.choices[0].delta.content)
            assert "".join(text) == "Hi there"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        llm = next(e for e in events if e["kind"] == "llm")
        assert llm["parent_span_id"] == ws_span_id


# ─── Anthropic: same contract ────────────────────────────────────────


class TestAnthropicStreamingContextSync:
    def test_stream_consumed_after_trace_exits_still_chains(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def _evt_start():
            return SimpleNamespace(
                type="message_start",
                message=SimpleNamespace(
                    model="claude-3-5-sonnet-20241022",
                    usage=SimpleNamespace(input_tokens=10),
                ),
            )

        def _evt_delta(text):
            return SimpleNamespace(
                type="content_block_delta",
                delta=SimpleNamespace(type="text_delta", text=text),
            )

        def _evt_message_delta():
            return SimpleNamespace(
                type="message_delta",
                usage=SimpleNamespace(output_tokens=14),
                delta=SimpleNamespace(stop_reason="end_turn"),
            )

        def fake_create(**kwargs):
            def gen():
                yield _evt_start()
                yield _evt_delta("Claude ")
                yield _evt_delta("output")
                yield _evt_message_delta()
                yield SimpleNamespace(type="message_stop")

            return gen()

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(
                _FakeAnthropicClient(fake_create), provider="anthropic"
            )
            ws_span_id: str | None = None
            with sdk.trace("anth-workflow") as ctx:
                ws_span_id = ctx.span_id
                stream = client.messages.create(
                    model="claude-3-5-sonnet-20241022",
                    max_tokens=100,
                    messages=[{"role": "user", "content": "hi"}],
                    stream=True,
                )
            # consume after exit
            for _ in stream:
                pass
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        llm = next(e for e in events if e["kind"] == "llm")
        assert llm["parent_span_id"] == ws_span_id
        # Sanity: tokens still captured correctly through the late
        # iteration — proves the wrapper finally-block ran.
        assert llm["input_tokens"] == 10
        assert llm["output_tokens"] == 14
        assert llm["output_text"] == "Claude output"
