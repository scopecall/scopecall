"""Anthropic instrumentation tests.

Mirrors test_openai_instrumentation.py — same coverage matrix
(sync/async × streaming/non-streaming, error paths, trace integration)
but adapted to Anthropic's response shape:

  - usage.input_tokens / usage.output_tokens (not prompt_/completion_)
  - response.content as a list of content blocks (text + tool_use)
  - response.stop_reason (not finish_reason)
  - Streaming events: message_start / content_block_delta / message_delta
    (not OpenAI's flat chunk + delta shape)

The Anthropic-specific token-accumulation logic (input from
message_start, output from message_delta) is the most fragile part of
the instrumentation — these tests pin it down.
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
    time.sleep(0.5)
    from pathlib import Path

    p = Path(path)
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


# ─── Fake Anthropic client ────────────────────────────────────────────


class _FakeMessages:
    def __init__(self, create_fn):
        self.create = create_fn


class _FakeAnthropic:
    """Mimics anthropic.Anthropic() (sync): `client.messages.create(...)`."""

    def __init__(self, create_fn):
        self.messages = _FakeMessages(create_fn)


def _make_message(
    *,
    model: str = "claude-3-5-sonnet-20241022",
    text: str = "Hello from Claude",
    input_tokens: int = 12,
    output_tokens: int = 24,
    stop_reason: str = "end_turn",
    cache_read_input_tokens: int | None = None,
    extra_content_blocks: list[Any] | None = None,
) -> SimpleNamespace:
    """Build a SimpleNamespace tree matching anthropic-py 0.40.x's
    Message response. SimpleNamespace plays well with the getattr-based
    extraction in _anthropic.py."""
    usage_kwargs: dict[str, Any] = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }
    if cache_read_input_tokens is not None:
        usage_kwargs["cache_read_input_tokens"] = cache_read_input_tokens
    content: list[Any] = [SimpleNamespace(type="text", text=text)]
    if extra_content_blocks:
        content.extend(extra_content_blocks)
    return SimpleNamespace(
        model=model,
        usage=SimpleNamespace(**usage_kwargs),
        content=content,
        stop_reason=stop_reason,
    )


# Anthropic stream-event factories ─────────────────────────────────────


def _evt_message_start(
    model: str = "claude-3-5-sonnet-20241022",
    input_tokens: int = 0,
    cache_read_input_tokens: int | None = None,
) -> SimpleNamespace:
    usage_kwargs: dict[str, Any] = {"input_tokens": input_tokens}
    if cache_read_input_tokens is not None:
        usage_kwargs["cache_read_input_tokens"] = cache_read_input_tokens
    return SimpleNamespace(
        type="message_start",
        message=SimpleNamespace(
            model=model,
            usage=SimpleNamespace(**usage_kwargs),
        ),
    )


def _evt_content_block_delta(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(type="text_delta", text=text),
    )


def _evt_message_delta(
    output_tokens: int,
    stop_reason: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        type="message_delta",
        usage=SimpleNamespace(output_tokens=output_tokens),
        delta=SimpleNamespace(stop_reason=stop_reason),
    )


def _evt_message_stop() -> SimpleNamespace:
    return SimpleNamespace(type="message_stop")


# ─── Sync non-streaming ───────────────────────────────────────────────


class TestSyncNonStreaming:
    def test_emits_event_with_anthropic_specific_fields(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            return _make_message(
                text="Hello from Claude",
                input_tokens=42,
                output_tokens=84,
                stop_reason="end_turn",
                cache_read_input_tokens=7,
            )

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create), provider="anthropic"
            )
            response = client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=100,
                messages=[{"role": "user", "content": "Hi there"}],
            )
            assert response.content[0].text == "Hello from Claude"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["kind"] == "llm"
        assert ev["provider"] == "anthropic"
        assert ev["model"] == "claude-3-5-sonnet-20241022"
        assert ev["input_tokens"] == 42
        assert ev["output_tokens"] == 84
        # Anthropic's stop_reason maps to our finish_reason field.
        assert ev["finish_reason"] == "end_turn"
        assert ev["cache_read_tokens"] == 7
        assert ev["output_text"] == "Hello from Claude"

    def test_extracts_text_from_content_blocks(self):
        """Anthropic's response.content is a list of typed blocks; we
        only concatenate `type == 'text'` blocks into output_text."""
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            return _make_message(
                text="First text block.",
                extra_content_blocks=[
                    SimpleNamespace(type="text", text=" Second text block."),
                ],
            )

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create), provider="anthropic"
            )
            client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=100,
                messages=[{"role": "user", "content": "Hi"}],
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert events[0]["output_text"] == "First text block. Second text block."

    def test_tool_use_blocks_surface_in_tool_calls(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            # Mixed text + tool_use blocks. The text becomes output_text;
            # the tool_use becomes JSON in tool_calls.
            return _make_message(
                text="Calling tool…",
                stop_reason="tool_use",
                extra_content_blocks=[
                    SimpleNamespace(
                        type="tool_use",
                        id="tu_123",
                        name="get_weather",
                        input={"city": "Bengaluru"},
                    ),
                ],
            )

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create), provider="anthropic"
            )
            client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=100,
                messages=[{"role": "user", "content": "weather?"}],
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["output_text"] == "Calling tool…"
        assert ev["finish_reason"] == "tool_use"
        assert ev["tool_calls"] is not None
        decoded = json.loads(ev["tool_calls"])
        assert decoded[0]["name"] == "get_weather"
        assert decoded[0]["input"] == {"city": "Bengaluru"}

    def test_capture_content_false_drops_both_directions(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            return _make_message(text="secret response")

        sdk = scopecall.init(output=path, flush_interval=0.1, capture_content=False)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create), provider="anthropic"
            )
            client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=100,
                messages=[{"role": "user", "content": "secret prompt"}],
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert events[0]["input_text"] is None
        assert events[0]["output_text"] is None


# ─── Sync streaming ───────────────────────────────────────────────────


class TestSyncStreaming:
    def test_stream_assembles_text_and_tokens_from_events(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            assert kwargs.get("stream") is True

            def gen():
                # Anthropic's event stream is much chattier than
                # OpenAI's — these are the events we care about.
                yield _evt_message_start(input_tokens=10, cache_read_input_tokens=3)
                yield _evt_content_block_delta("Hello ")
                yield _evt_content_block_delta("from ")
                yield _evt_content_block_delta("Claude")
                yield _evt_message_delta(output_tokens=18, stop_reason="end_turn")
                yield _evt_message_stop()

            return gen()

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create), provider="anthropic"
            )
            stream = client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=100,
                messages=[{"role": "user", "content": "Hi"}],
                stream=True,
            )
            # Consume the stream — yielding through the wrapper should
            # not interfere with the events the caller sees.
            seen_types: list[str] = []
            for evt in stream:
                seen_types.append(getattr(evt, "type", "?"))
            assert "message_start" in seen_types
            assert "content_block_delta" in seen_types
            assert "message_delta" in seen_types
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["output_text"] == "Hello from Claude"
        assert ev["input_tokens"] == 10
        assert ev["output_tokens"] == 18
        assert ev["cache_read_tokens"] == 3
        assert ev["finish_reason"] == "end_turn"
        assert ev["ttft_ms"] is not None
        assert ev["ttft_ms"] >= 0


# ─── Async paths ──────────────────────────────────────────────────────


class TestAsync:
    async def test_async_non_streaming(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        async def fake_create_async(**kwargs):
            return _make_message(text="async claude")

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create_async), provider="anthropic"
            )
            response = await client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=100,
                messages=[{"role": "user", "content": "hi"}],
            )
            assert response.content[0].text == "async claude"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert events[0]["output_text"] == "async claude"

    async def test_async_streaming(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        async def fake_create_async(**kwargs):
            async def agen():
                yield _evt_message_start(input_tokens=5)
                yield _evt_content_block_delta("Hi ")
                yield _evt_content_block_delta("there")
                yield _evt_message_delta(output_tokens=8, stop_reason="end_turn")

            return agen()

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create_async), provider="anthropic"
            )
            stream = await client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=100,
                messages=[{"role": "user", "content": "go"}],
                stream=True,
            )
            text_parts: list[str] = []
            async for evt in stream:
                if (
                    getattr(evt, "type", "") == "content_block_delta"
                    and getattr(evt.delta, "type", "") == "text_delta"
                ):
                    text_parts.append(evt.delta.text)
            assert "".join(text_parts) == "Hi there"
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
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
            raise RuntimeError("anthropic provider error")

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create), provider="anthropic"
            )
            with pytest.raises(RuntimeError, match="anthropic provider"):
                client.messages.create(
                    model="claude-3-5-sonnet-20241022",
                    max_tokens=100,
                    messages=[{"role": "user", "content": "x"}],
                )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        ev = events[0]
        assert ev["status"] == "error"
        assert ev["error_message"] == "anthropic provider error"
        assert ev["provider"] == "anthropic"

    def test_429_emits_rate_limited_status(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        class _RateLimit(Exception):
            status_code = 429

        def fake_create(**kwargs):
            raise _RateLimit("too fast")

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create), provider="anthropic"
            )
            with pytest.raises(_RateLimit):
                client.messages.create(
                    model="claude-3-5-sonnet-20241022",
                    max_tokens=100,
                    messages=[{"role": "user", "content": "x"}],
                )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert events[0]["status"] == "rate_limited"


# ─── Trace context integration ────────────────────────────────────────


class TestTraceContextIntegration:
    def test_call_inside_trace_attaches_to_workflow_span(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            return _make_message()

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            client = sdk.instrument(
                _FakeAnthropic(fake_create), provider="anthropic"
            )
            with sdk.trace("with-claude", user_id="u_a") as ctx:
                client.messages.create(
                    model="claude-3-5-sonnet-20241022",
                    max_tokens=100,
                    messages=[{"role": "user", "content": "hello"}],
                )
                ws = ctx.span_id
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        llm = next(e for e in events if e["kind"] == "llm")
        wf = next(e for e in events if e["kind"] == "workflow")
        assert llm["parent_span_id"] == ws
        assert llm["user_id"] == "u_a"
        assert llm["trace_id"] == wf["trace_id"]


# ─── Bad inputs ───────────────────────────────────────────────────────


class TestBadInputs:
    def test_instrument_on_wrong_type_raises_useful_error(self):
        sdk = scopecall.init(debug=True)
        try:
            with pytest.raises(TypeError, match="Anthropic"):
                sdk.instrument(object(), provider="anthropic")
        finally:
            sdk.close(timeout=2.0)

    def test_unknown_provider_string_raises(self):
        sdk = scopecall.init(debug=True)
        try:
            with pytest.raises(ValueError, match="unknown provider"):
                sdk.instrument(_FakeAnthropic(lambda **kw: None), provider="zorp")
        finally:
            sdk.close(timeout=2.0)
