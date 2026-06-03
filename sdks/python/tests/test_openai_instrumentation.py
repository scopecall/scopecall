"""OpenAI instrumentation tests.

We test the monkey-patch wrapper without depending on the real openai
package — a fake client with the same .chat.completions.create shape
gives us deterministic control over the response and lets the test
suite run in <100ms with no network.

What's covered:
  - Sync non-streaming → emits one LLMEvent with tokens, output_text,
    finish_reason populated from the response.
  - Sync streaming → emits one LLMEvent with TTFT + assembled
    output_text + final usage from the last chunk.
  - Async non-streaming → same as sync.
  - Async streaming → same as sync streaming.
  - Auto-add stream_options.include_usage=True when missing.
  - Honor stream_options.include_usage=False when explicitly set.
  - Error path → emits status='error' with the exception message.
  - HTTP 429 → emits status='rate_limited'.
  - Inside sdk.trace() → parent_span_id is set to the workflow span.
  - capture_content=False → input_text/output_text are None.

Reading these tests as documentation: each one mirrors a row in the
TS SDK's own test suite (sdks/typescript/test/openai*.test.ts).
Parity in tests = parity in behavior.
"""

from __future__ import annotations

import json
import tempfile
import time
from types import SimpleNamespace
from typing import Any

import pytest

import scopecall


def _read_events(path: str) -> list[dict[str, Any]]:
    """Read NDJSON events written by file-mode transport. Sleeps briefly
    so the background flush thread has time to tick."""
    time.sleep(0.5)
    from pathlib import Path

    p = Path(path)
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


# ─── Fake OpenAI client ───────────────────────────────────────────────


class _FakeCompletions:
    """Mock for openai-py's `client.chat.completions`.

    `create` is configurable: pass a callable to drive sync/async/stream
    behavior. This keeps each test in one place — no fixture sprawl.
    """

    def __init__(self, create_fn):
        self.create = create_fn


class _FakeChat:
    def __init__(self, create_fn):
        self.completions = _FakeCompletions(create_fn)


class _FakeOpenAI:
    """Mimics the surface area `instrument_openai` reaches into.

    Mirrors openai.OpenAI() (sync): `client.chat.completions.create(...)`
    returns a ChatCompletion-like object directly.
    """

    def __init__(self, create_fn):
        self.chat = _FakeChat(create_fn)


def _make_chat_completion(
    *,
    model: str = "gpt-4o-mini",
    content: str = "Hello world",
    prompt_tokens: int = 10,
    completion_tokens: int = 20,
    finish_reason: str = "stop",
    cached_tokens: int | None = None,
) -> SimpleNamespace:
    """Build a SimpleNamespace tree matching openai-py 1.x's
    ChatCompletion response. SimpleNamespace plays well with the
    getattr-based extraction in _openai.py."""
    usage_kwargs = {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
    }
    if cached_tokens is not None:
        usage_kwargs["prompt_tokens_details"] = SimpleNamespace(
            cached_tokens=cached_tokens
        )
    return SimpleNamespace(
        model=model,
        usage=SimpleNamespace(**usage_kwargs),
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=content, tool_calls=None),
                finish_reason=finish_reason,
            )
        ],
    )


def _make_stream_chunk(
    *,
    delta_content: str | None = None,
    finish_reason: str | None = None,
    usage: SimpleNamespace | None = None,
    model: str = "gpt-4o-mini",
) -> SimpleNamespace:
    """Build a ChatCompletionChunk-like object for streaming tests."""
    return SimpleNamespace(
        model=model,
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=delta_content),
                finish_reason=finish_reason,
            )
        ],
        usage=usage,
    )


# ─── Sync non-streaming ───────────────────────────────────────────────


class TestSyncNonStreaming:
    def test_emits_one_event_with_extracted_fields(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        captured_kwargs: list[dict] = []

        def fake_create(**kwargs):
            captured_kwargs.append(kwargs)
            return _make_chat_completion(
                content="Hello world",
                prompt_tokens=42,
                completion_tokens=84,
                finish_reason="stop",
                cached_tokens=5,
            )

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create))
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "Hi there"}],
            )
            assert response.choices[0].message.content == "Hello world"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        # The wrapper called through with the original kwargs intact.
        assert captured_kwargs[0]["model"] == "gpt-4o-mini"
        assert captured_kwargs[0]["messages"][0]["content"] == "Hi there"

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["kind"] == "llm"
        assert ev["provider"] == "openai"
        assert ev["model"] == "gpt-4o-mini"
        assert ev["input_tokens"] == 42
        assert ev["output_tokens"] == 84
        assert ev["finish_reason"] == "stop"
        assert ev["cache_read_tokens"] == 5
        assert ev["output_text"] == "Hello world"
        # input_text contains the role-prefixed messages flatten.
        assert "user: Hi there" in (ev["input_text"] or "")
        # ttft_ms is None on non-streaming — TTFT is a streaming concept.
        assert ev["ttft_ms"] is None
        # latency_ms is recorded but not asserted to a specific value —
        # depends on the test runner. We assert >= 0 as a smoke check.
        assert ev["latency_ms"] >= 0

    def test_capture_content_false_redacts_both_directions(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            return _make_chat_completion(content="secret response")

        sdk = scopecall.init(output=path, flush_interval=0.1, capture_content=False)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create))
            client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "secret prompt"}],
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        assert events[0]["input_text"] is None
        assert events[0]["output_text"] is None


# ─── Sync streaming ───────────────────────────────────────────────────


class TestSyncStreaming:
    def test_stream_assembles_text_and_records_ttft(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            # Caller iterates this; we yield three deltas + a usage-only
            # final chunk. include_usage was set by the wrapper.
            assert kwargs.get("stream") is True
            assert kwargs.get("stream_options", {}).get("include_usage") is True

            def gen():
                yield _make_stream_chunk(delta_content="Hello")
                yield _make_stream_chunk(delta_content=" ")
                yield _make_stream_chunk(delta_content="world")
                yield _make_stream_chunk(
                    delta_content=None,
                    finish_reason="stop",
                )
                yield _make_stream_chunk(
                    delta_content=None,
                    usage=SimpleNamespace(prompt_tokens=10, completion_tokens=15),
                )

            return gen()

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create))
            stream = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "Hi"}],
                stream=True,
            )
            collected = "".join(
                (c.choices[0].delta.content or "") for c in stream
            )
            assert collected == "Hello world"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["output_text"] == "Hello world"
        assert ev["finish_reason"] == "stop"
        assert ev["input_tokens"] == 10
        assert ev["output_tokens"] == 15
        # TTFT was set on the first chunk; should be >= 0.
        assert ev["ttft_ms"] is not None
        assert ev["ttft_ms"] >= 0

    def test_caller_explicit_include_usage_false_honored(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        seen_kwargs: dict = {}

        def fake_create(**kwargs):
            seen_kwargs.update(kwargs)

            def gen():
                yield _make_stream_chunk(
                    delta_content="ok", finish_reason="stop"
                )

            return gen()

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create))
            stream = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "hi"}],
                stream=True,
                stream_options={"include_usage": False},
            )
            for _ in stream:
                pass
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        # The user opted out of include_usage — we must NOT override.
        assert seen_kwargs["stream_options"]["include_usage"] is False


# ─── Async paths ──────────────────────────────────────────────────────


class TestAsync:
    """Async wrappers — verify they wrap correctly via iscoroutinefunction
    detection."""

    async def test_async_non_streaming(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        async def fake_create_async(**kwargs):
            return _make_chat_completion(content="async hello")

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create_async))
            response = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "hi"}],
            )
            assert response.choices[0].message.content == "async hello"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        assert events[0]["output_text"] == "async hello"

    async def test_async_streaming(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        async def fake_create_async(**kwargs):
            async def agen():
                yield _make_stream_chunk(delta_content="Hi ")
                yield _make_stream_chunk(delta_content="there")
                yield _make_stream_chunk(
                    delta_content=None, finish_reason="stop"
                )
                yield _make_stream_chunk(
                    delta_content=None,
                    usage=SimpleNamespace(prompt_tokens=5, completion_tokens=8),
                )

            return agen()

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create_async))
            stream = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "go"}],
                stream=True,
            )
            collected_parts = []
            async for chunk in stream:
                if chunk.choices[0].delta.content:
                    collected_parts.append(chunk.choices[0].delta.content)
            assert "".join(collected_parts) == "Hi there"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["output_text"] == "Hi there"
        assert ev["input_tokens"] == 5
        assert ev["output_tokens"] == 8


# ─── Error paths ──────────────────────────────────────────────────────


class TestErrorPaths:
    def test_exception_emits_error_event_and_reraises(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            raise RuntimeError("simulated provider error")

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create))
            with pytest.raises(RuntimeError, match="simulated"):
                client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": "x"}],
                )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["status"] == "error"
        assert ev["error_message"] == "simulated provider error"
        assert ev["output_text"] == ""  # never produced

    def test_429_emits_rate_limited_status(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        class _RateLimitErr(Exception):
            status_code = 429

        def fake_create(**kwargs):
            raise _RateLimitErr("too many requests")

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create))
            with pytest.raises(_RateLimitErr):
                client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": "x"}],
                )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        assert events[0]["status"] == "rate_limited"


# ─── Context integration ──────────────────────────────────────────────


class TestTraceContextIntegration:
    def test_call_inside_trace_attaches_to_workflow_span(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            return _make_chat_completion()

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(_FakeOpenAI(fake_create))
            with sdk.trace("with-llm", user_id="u_test") as ctx:
                client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": "hello"}],
                )
                workflow_span_id = ctx.span_id
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 2
        llm = next(e for e in events if e["kind"] == "llm")
        wf = next(e for e in events if e["kind"] == "workflow")
        assert llm["parent_span_id"] == workflow_span_id
        assert wf["span_id"] == workflow_span_id
        assert llm["user_id"] == "u_test"  # inherited from trace ctx
        assert llm["trace_id"] == wf["trace_id"]


# ─── Bad inputs ───────────────────────────────────────────────────────


class TestBadInputs:
    def test_instrument_on_wrong_type_raises_useful_error(self):
        sdk = scopecall.init(debug=True)
        try:
            # An object without .chat.completions is not an OpenAI client.
            with pytest.raises(TypeError, match="OpenAI"):
                sdk.instrument(object(), provider="openai")
        finally:
            sdk.close(timeout=2.0)
