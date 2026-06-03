"""Anthropic client instrumentation.

Mirrors the structure of `_openai.py` — direct monkey-patch on
`client.messages.create`, sync + async + streaming auto-detected from
the method.

Anthropic-specific differences from OpenAI:

  - Response shape: usage uses `input_tokens` / `output_tokens` (not
    `prompt_tokens` / `completion_tokens`). Cache fields are named
    `cache_read_input_tokens` / `cache_creation_input_tokens`.
  - Content: response.content is a list of blocks; text lives in
    `block.text` for `block.type == "text"`. Multiple blocks possible
    (text + tool_use blocks).
  - Finish: response.stop_reason (not finish_reason).
  - Streaming event types: message_start, content_block_start,
    content_block_delta, content_block_stop, message_delta, message_stop.
    Token deltas arrive in `message_delta` (usage.output_tokens) — the
    final tally is the SUM of message_start.usage.input_tokens +
    message_delta.usage.output_tokens (anthropic-py 0.20+ ships an
    `accumulated_usage` property on the stream object but we don't
    rely on it because some SDK versions don't expose it).

We follow the same conservative approach as OpenAI: never raise from
inside the wrapper, swallow attribute errors, fall back to empty
strings / zero counts when the response shape is unexpected.
"""

from __future__ import annotations

import inspect
import time
from collections.abc import AsyncIterator, Iterator
from typing import TYPE_CHECKING, Any

from .. import _context
from ._common import (
    build_llm_event,
    emit,
    extract_messages_text,
    now_ms,
    tool_calls_to_json,
)

if TYPE_CHECKING:
    from .._sdk import ScopeCallSDK

PROVIDER = "anthropic"


def instrument_anthropic(client: Any, sdk: ScopeCallSDK) -> None:
    """Replace `client.messages.create` with a tracing wrapper.

    Same idempotency story as the OpenAI version: calling instrument
    twice nests the wrappers and produces duplicate events. The
    caller should call instrument exactly once per client.

    Auto-detects sync vs async by inspecting the method.
    """
    try:
        messages = client.messages
    except AttributeError as exc:
        raise TypeError(
            "scopecall.instrument(client, provider='anthropic') expects an "
            "Anthropic() or AsyncAnthropic() instance; got "
            f"{type(client).__name__} (no .messages found)."
        ) from exc

    original_create = messages.create
    # inspect.iscoroutinefunction over asyncio.iscoroutinefunction (deprecated
    # for removal in Python 3.16). Same semantics, future-proof.
    is_async = inspect.iscoroutinefunction(original_create)

    if is_async:
        async def wrapped_async(*args: Any, **kwargs: Any) -> Any:
            return await _traced_create_async(sdk, original_create, args, kwargs)

        messages.create = wrapped_async
    else:
        def wrapped_sync(*args: Any, **kwargs: Any) -> Any:
            return _traced_create_sync(sdk, original_create, args, kwargs)

        messages.create = wrapped_sync


# ─── Sync path ────────────────────────────────────────────────────────


def _traced_create_sync(
    sdk: ScopeCallSDK,
    original_create: Any,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> Any:
    streaming = bool(kwargs.get("stream", False))
    # Snapshot the active trace context at create()-time. For streaming
    # we pass it into the stream wrapper so the LLM event chains
    # correctly even when iteration happens after the enclosing
    # `sdk.trace()` block has exited. See _openai.py for the long
    # rationale. Round-12 review P0b.
    ctx_snapshot = _context.get_current()
    start_mono = time.monotonic()
    timestamp_ms = now_ms()

    try:
        response = original_create(*args, **kwargs)
    except Exception as exc:
        _emit_error(sdk, kwargs, timestamp_ms, start_mono, exc, ctx_snapshot)
        raise

    if streaming:
        return _wrap_stream_sync(
            response, sdk, kwargs, timestamp_ms, start_mono, ctx_snapshot
        )
    else:
        _emit_nonstreaming(
            sdk, kwargs, response, timestamp_ms, start_mono, ctx_snapshot
        )
        return response


def _wrap_stream_sync(
    stream: Any,
    sdk: ScopeCallSDK,
    request_kwargs: dict[str, Any],
    timestamp_ms: float,
    start_mono: float,
    ctx_snapshot: _context.TraceContext | None,
) -> Iterator[Any]:
    """Sync iterator wrapper for Anthropic's event stream.

    Anthropic's stream yields typed event objects (MessageStartEvent,
    ContentBlockDeltaEvent, etc.). We discriminate on `event.type` —
    a string attribute present on every event class — rather than
    isinstance because the class hierarchy changes between
    anthropic-py minor versions.
    """
    text_chunks: list[str] = []
    ttft_ms: int | None = None
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens: int | None = None
    stop_reason: str | None = None
    model: str | None = None
    error_message: str | None = None
    status = "success"

    try:
        for event in stream:
            if ttft_ms is None:
                ttft_ms = int((time.monotonic() - start_mono) * 1000)
            (
                input_tokens,
                output_tokens,
                cache_read_tokens,
                stop_reason,
                model_from_event,
            ) = _process_anthropic_event(
                event,
                text_chunks,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                stop_reason,
            )
            if model is None and model_from_event:
                model = model_from_event
            yield event
    except Exception as exc:
        status = "error"
        error_message = str(exc)
        raise
    finally:
        latency_ms = int((time.monotonic() - start_mono) * 1000)
        _emit_from_stream(
            sdk,
            request_kwargs=request_kwargs,
            model=model or _extract_model(request_kwargs),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            output_text="".join(text_chunks),
            stop_reason=stop_reason,
            timestamp_ms=timestamp_ms,
            latency_ms=latency_ms,
            ttft_ms=ttft_ms,
            status=status,
            error_message=error_message,
            ctx_snapshot=ctx_snapshot,
        )


# ─── Async path ───────────────────────────────────────────────────────


async def _traced_create_async(
    sdk: ScopeCallSDK,
    original_create: Any,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> Any:
    streaming = bool(kwargs.get("stream", False))
    ctx_snapshot = _context.get_current()
    start_mono = time.monotonic()
    timestamp_ms = now_ms()

    try:
        response = await original_create(*args, **kwargs)
    except Exception as exc:
        _emit_error(sdk, kwargs, timestamp_ms, start_mono, exc, ctx_snapshot)
        raise

    if streaming:
        return _wrap_stream_async(
            response, sdk, kwargs, timestamp_ms, start_mono, ctx_snapshot
        )
    else:
        _emit_nonstreaming(
            sdk, kwargs, response, timestamp_ms, start_mono, ctx_snapshot
        )
        return response


async def _wrap_stream_async(
    stream: Any,
    sdk: ScopeCallSDK,
    request_kwargs: dict[str, Any],
    timestamp_ms: float,
    start_mono: float,
    ctx_snapshot: _context.TraceContext | None,
) -> AsyncIterator[Any]:
    """Async iterator wrapper — parallel to the sync variant. See note in
    `_openai.py:_wrap_stream_async` about why we can't share code."""
    text_chunks: list[str] = []
    ttft_ms: int | None = None
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens: int | None = None
    stop_reason: str | None = None
    model: str | None = None
    error_message: str | None = None
    status = "success"

    try:
        async for event in stream:
            if ttft_ms is None:
                ttft_ms = int((time.monotonic() - start_mono) * 1000)
            (
                input_tokens,
                output_tokens,
                cache_read_tokens,
                stop_reason,
                model_from_event,
            ) = _process_anthropic_event(
                event,
                text_chunks,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                stop_reason,
            )
            if model is None and model_from_event:
                model = model_from_event
            yield event
    except Exception as exc:
        status = "error"
        error_message = str(exc)
        raise
    finally:
        latency_ms = int((time.monotonic() - start_mono) * 1000)
        _emit_from_stream(
            sdk,
            request_kwargs=request_kwargs,
            model=model or _extract_model(request_kwargs),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            output_text="".join(text_chunks),
            stop_reason=stop_reason,
            timestamp_ms=timestamp_ms,
            latency_ms=latency_ms,
            ttft_ms=ttft_ms,
            status=status,
            error_message=error_message,
            ctx_snapshot=ctx_snapshot,
        )


# ─── Shared helpers ───────────────────────────────────────────────────


def _extract_model(kwargs: dict[str, Any]) -> str:
    m = kwargs.get("model", "")
    return str(m) if m else ""


def _process_anthropic_event(
    event: Any,
    text_chunks: list[str],
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int | None,
    stop_reason: str | None,
) -> tuple[int, int, int | None, str | None, str | None]:
    """Process one event from an Anthropic message stream, mutating the
    accumulator state via the tuple return.

    Anthropic event types we care about:
      message_start         → carries the model + initial usage
                              (input_tokens, cache_read_input_tokens)
      content_block_delta   → carries delta.text (or delta.partial_json
                              for tool_use blocks, which we ignore for
                              the output_text aggregate)
      message_delta         → carries final usage.output_tokens AND
                              stop_reason
      message_stop          → terminator (no payload we use)

    `event.type` is the discriminator. Older anthropic-py versions
    don't always populate every attribute on every event; we use
    getattr with sensible defaults rather than dotted access.

    Returns the (possibly-updated) accumulator state as a tuple. We
    return rather than mutate caller-locals because Python closures
    can't rebind outer-scope ints easily, and this is clearer.
    """
    model: str | None = None
    etype = getattr(event, "type", None)
    try:
        if etype == "message_start":
            msg = getattr(event, "message", None)
            if msg is not None:
                model = getattr(msg, "model", None) or model
                usage = getattr(msg, "usage", None)
                if usage is not None:
                    # message_start.usage.input_tokens is the FULL input
                    # count; subsequent message_delta only updates
                    # output_tokens. Same for cache_read_input_tokens.
                    input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
                    crit = getattr(usage, "cache_read_input_tokens", None)
                    if crit is not None:
                        cache_read_tokens = int(crit)
        elif etype == "content_block_delta":
            delta = getattr(event, "delta", None)
            if delta is not None:
                # text_delta blocks have .text; tool_use partial_json
                # blocks we ignore for the output_text aggregate (we'd
                # need to assemble the JSON and that's expensive).
                delta_type = getattr(delta, "type", None)
                if delta_type == "text_delta":
                    t = getattr(delta, "text", None)
                    if t:
                        text_chunks.append(str(t))
        elif etype == "message_delta":
            usage = getattr(event, "usage", None)
            if usage is not None:
                output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
            delta = getattr(event, "delta", None)
            if delta is not None:
                sr = getattr(delta, "stop_reason", None)
                if sr:
                    stop_reason = sr
    except Exception:  # noqa: BLE001
        # A single bad event shouldn't break the trace.
        pass

    return input_tokens, output_tokens, cache_read_tokens, stop_reason, model


def _emit_nonstreaming(
    sdk: ScopeCallSDK,
    request_kwargs: dict[str, Any],
    response: Any,
    timestamp_ms: float,
    start_mono: float,
    ctx_snapshot: _context.TraceContext | None,
) -> None:
    """Pull tokens / output / stop_reason out of a non-streaming
    messages.create response and emit.

    anthropic-py response shape (verified against 0.40.x):
      response.model
      response.usage.input_tokens
      response.usage.output_tokens
      response.usage.cache_read_input_tokens (optional)
      response.content              — list of content blocks
      response.stop_reason          — "end_turn" / "max_tokens" / "stop_sequence"
                                      / "tool_use"
    """
    latency_ms = int((time.monotonic() - start_mono) * 1000)

    model = getattr(response, "model", "") or _extract_model(request_kwargs)
    usage = getattr(response, "usage", None)
    input_tokens = int(getattr(usage, "input_tokens", 0) or 0) if usage else 0
    output_tokens = int(getattr(usage, "output_tokens", 0) or 0) if usage else 0
    cache_read_tokens: int | None = None
    if usage is not None:
        crit = getattr(usage, "cache_read_input_tokens", None)
        if crit is not None:
            cache_read_tokens = int(crit)

    # Assemble output_text from content blocks. tool_use blocks are
    # captured separately into `tool_calls` so they're visible in the
    # dashboard's trace detail without polluting the human-readable
    # output_text column.
    output_text_parts: list[str] = []
    tool_blocks: list[Any] = []
    content = getattr(response, "content", None) or []
    for block in content:
        block_type = getattr(block, "type", None)
        if block_type == "text":
            output_text_parts.append(str(getattr(block, "text", "")))
        elif block_type == "tool_use":
            # The block has .id, .name, .input — serialise the
            # tuple, not the whole block object (which is a
            # pydantic model and might not JSON-encode cleanly).
            tool_blocks.append(
                {
                    "id": getattr(block, "id", None),
                    "name": getattr(block, "name", None),
                    "input": getattr(block, "input", None),
                }
            )
    output_text = "".join(output_text_parts)

    stop_reason = getattr(response, "stop_reason", None)
    input_text = extract_messages_text(request_kwargs.get("messages", []))

    event = build_llm_event(
        sdk,
        model=str(model),
        provider=PROVIDER,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        latency_ms=latency_ms,
        timestamp_ms=timestamp_ms,
        status="success",
        input_text=input_text,
        output_text=output_text,
        finish_reason=stop_reason,
        cache_read_tokens=cache_read_tokens,
        tool_calls=tool_calls_to_json(tool_blocks) if tool_blocks else None,
        ctx_override=ctx_snapshot,
    )
    emit(sdk, event)


def _emit_from_stream(
    sdk: ScopeCallSDK,
    *,
    request_kwargs: dict[str, Any],
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int | None,
    output_text: str,
    stop_reason: str | None,
    timestamp_ms: float,
    latency_ms: int,
    ttft_ms: int | None,
    status: str,
    error_message: str | None,
    ctx_snapshot: _context.TraceContext | None,
) -> None:
    input_text = extract_messages_text(request_kwargs.get("messages", []))
    event = build_llm_event(
        sdk,
        model=model,
        provider=PROVIDER,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        latency_ms=latency_ms,
        timestamp_ms=timestamp_ms,
        status=status,
        ttft_ms=ttft_ms,
        input_text=input_text,
        output_text=output_text,
        finish_reason=stop_reason,
        cache_read_tokens=cache_read_tokens,
        error_message=error_message,
        ctx_override=ctx_snapshot,
    )
    emit(sdk, event)


def _emit_error(
    sdk: ScopeCallSDK,
    request_kwargs: dict[str, Any],
    timestamp_ms: float,
    start_mono: float,
    exc: BaseException,
    ctx_snapshot: _context.TraceContext | None,
) -> None:
    latency_ms = int((time.monotonic() - start_mono) * 1000)
    status_code = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if status_code == 429:
        status = "rate_limited"
    elif "Timeout" in type(exc).__name__:
        status = "timeout"
    else:
        status = "error"

    input_text = extract_messages_text(request_kwargs.get("messages", []))
    event = build_llm_event(
        sdk,
        model=_extract_model(request_kwargs),
        provider=PROVIDER,
        input_tokens=0,
        output_tokens=0,
        latency_ms=latency_ms,
        timestamp_ms=timestamp_ms,
        status=status,
        input_text=input_text,
        output_text="",
        error_message=str(exc),
        ctx_override=ctx_snapshot,
    )
    emit(sdk, event)
