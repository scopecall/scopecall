"""OpenAI client instrumentation.

Direct monkey-patch on the `chat.completions.create` method of the
client instance the user passes in. Mirrors the TS SDK's approach in
`sdks/typescript/src/instrumentation/openai.ts`.

What's covered:
  - openai.OpenAI() — sync, non-streaming
  - openai.OpenAI() — sync, streaming (auto-adds stream_options.include_usage=True)
  - openai.AsyncOpenAI() — async, non-streaming
  - openai.AsyncOpenAI() — async, streaming

What's NOT covered (deferred to a later release):
  - The legacy `openai.completions.create` (text completion) endpoint —
    superseded by chat.completions; deprecated by OpenAI itself.
  - The Responses API (openai.responses.create) — newer surface, low
    adoption today, will come in v0.2.x once the upstream stabilises.
  - The Assistants API — too stateful for a single-event trace shape.

Why monkey-patching rather than a callback / OTel exporter: openai-py
doesn't expose hooks, and an OTel-based approach drags in the whole
opentelemetry-sdk dependency tree. The patch is small (one method per
client instance), explicit, and easy to reason about.
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

PROVIDER = "openai"


def instrument_openai(client: Any, sdk: ScopeCallSDK) -> None:
    """Replace `client.chat.completions.create` with a tracing wrapper.

    Idempotent in spirit — calling instrument twice on the same client
    nests the wrappers, which produces duplicate events. We don't try
    to detect this because the TS SDK doesn't either; it's a footgun
    documented in the README rather than a runtime check.

    Auto-detects sync vs async from the existing method. We don't sniff
    the class name because openai-py occasionally reshuffles class
    hierarchies between minor versions; checking if the method is a
    coroutine function is the more stable signal.
    """
    try:
        completions = client.chat.completions
    except AttributeError as exc:
        # The caller passed something that isn't an OpenAI / AsyncOpenAI
        # instance. Raise loudly with a useful message — silent swallow
        # would let the user think instrumentation worked and then
        # wonder why no events appear.
        raise TypeError(
            "scopecall.instrument(client, provider='openai') expects an "
            "OpenAI() or AsyncOpenAI() instance; got "
            f"{type(client).__name__} (no .chat.completions found)."
        ) from exc

    original_create = completions.create
    # inspect.iscoroutinefunction is the long-term API; asyncio.iscoroutinefunction
    # is deprecated for removal in Python 3.16. They behave identically for our
    # purposes (sync vs async method dispatch).
    is_async = inspect.iscoroutinefunction(original_create)

    if is_async:
        async def wrapped_async(*args: Any, **kwargs: Any) -> Any:
            return await _traced_create_async(sdk, original_create, args, kwargs)

        completions.create = wrapped_async
    else:
        def wrapped_sync(*args: Any, **kwargs: Any) -> Any:
            return _traced_create_sync(sdk, original_create, args, kwargs)

        completions.create = wrapped_sync


# ─── Sync path ────────────────────────────────────────────────────────


def _traced_create_sync(
    sdk: ScopeCallSDK,
    original_create: Any,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> Any:
    streaming = bool(kwargs.get("stream", False))
    if streaming:
        # Auto-add stream_options.include_usage=True so the final chunk
        # carries token counts. We only set this if the user didn't
        # explicitly set it — passing include_usage=False is a
        # legitimate caller choice (e.g. structured output where the
        # caller doesn't care about cost), and we honor it.
        _ensure_include_usage(kwargs)

    # Snapshot the active trace context HERE — at create() time, while
    # the user's `with sdk.trace():` block is still on the stack. For
    # streaming we pass this snapshot into the stream wrapper so the
    # LLM event still chains correctly even if the stream is consumed
    # AFTER the trace block exits (the FastAPI streaming pattern).
    # Without this, `_context.get_current()` at emit time returns None
    # and the event becomes orphan. Round-12 review P0b.
    ctx_snapshot = _context.get_current()

    start_mono = time.monotonic()
    timestamp_ms = now_ms()

    try:
        response = original_create(*args, **kwargs)
    except Exception as exc:
        _emit_error(sdk, kwargs, timestamp_ms, start_mono, exc, ctx_snapshot)
        raise

    if streaming:
        # Wrap the iterator so we capture deltas / TTFT / final usage.
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
    """Iterator wrapper that captures deltas as they arrive.

    We yield each chunk untouched so the caller sees the exact upstream
    behavior. The wrapper's only side effects are:
      - Recording TTFT on the first chunk
      - Accumulating delta content into a single string
      - Pulling token counts from the final chunk (include_usage=True)
      - Emitting one LLMEvent on stream completion (or error)

    `ctx_snapshot` is the TraceContext captured at create()-time. We
    use it instead of `_context.get_current()` at emit time so the
    LLM event chains to the right parent even when the caller consumes
    the stream AFTER the enclosing `sdk.trace()` block has exited.
    Round-12 review P0b.
    """
    chunks_text: list[str] = []
    ttft_ms: int | None = None
    usage: Any = None
    finish_reason: str | None = None
    model: str | None = None
    error_message: str | None = None
    status = "success"

    try:
        for chunk in stream:
            if ttft_ms is None:
                ttft_ms = int((time.monotonic() - start_mono) * 1000)
            _accumulate_chunk(chunk, chunks_text)
            if not model:
                model = getattr(chunk, "model", None)
            if usage is None:
                usage = getattr(chunk, "usage", None)
            for choice in getattr(chunk, "choices", []) or []:
                fr = getattr(choice, "finish_reason", None)
                if fr:
                    finish_reason = fr
            yield chunk
    except Exception as exc:
        # The caller's `for` loop is what raised. We re-raise after
        # emitting an error event so the caller's exception handling
        # is unchanged.
        status = "error"
        error_message = str(exc)
        raise
    finally:
        latency_ms = int((time.monotonic() - start_mono) * 1000)
        _emit_from_stream(
            sdk,
            request_kwargs=request_kwargs,
            model=model or _extract_model(request_kwargs),
            usage=usage,
            output_text="".join(chunks_text),
            finish_reason=finish_reason,
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
    if streaming:
        _ensure_include_usage(kwargs)

    # Same context-snapshot rationale as the sync path — see the long
    # comment in `_traced_create_sync`. The async streaming case is
    # the headline example: FastAPI returns a StreamingResponse whose
    # event_source iterator runs after the route handler's
    # `with sdk.trace():` has exited.
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
    """Async iterator wrapper — same shape as the sync variant.

    We can't share code between the two because Python's generator
    protocol is fundamentally different for async (PEP 492). Keeping
    them parallel is the price; the alternative (a class-based
    iterator implementing both __iter__ and __aiter__) is uglier and
    harder to debug.
    """
    chunks_text: list[str] = []
    ttft_ms: int | None = None
    usage: Any = None
    finish_reason: str | None = None
    model: str | None = None
    error_message: str | None = None
    status = "success"

    try:
        async for chunk in stream:
            if ttft_ms is None:
                ttft_ms = int((time.monotonic() - start_mono) * 1000)
            _accumulate_chunk(chunk, chunks_text)
            if not model:
                model = getattr(chunk, "model", None)
            if usage is None:
                usage = getattr(chunk, "usage", None)
            for choice in getattr(chunk, "choices", []) or []:
                fr = getattr(choice, "finish_reason", None)
                if fr:
                    finish_reason = fr
            yield chunk
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
            usage=usage,
            output_text="".join(chunks_text),
            finish_reason=finish_reason,
            timestamp_ms=timestamp_ms,
            latency_ms=latency_ms,
            ttft_ms=ttft_ms,
            status=status,
            error_message=error_message,
            ctx_snapshot=ctx_snapshot,
        )


# ─── Shared helpers ───────────────────────────────────────────────────


def _ensure_include_usage(kwargs: dict[str, Any]) -> None:
    """Set stream_options.include_usage=True unless the caller already
    set it. Without this, streaming chunks don't carry token counts and
    the dashboard's cost columns stay zero."""
    opts = kwargs.get("stream_options")
    if opts is None:
        kwargs["stream_options"] = {"include_usage": True}
    elif isinstance(opts, dict) and "include_usage" not in opts:
        # User passed stream_options but didn't set include_usage.
        # We merge rather than overwrite so other keys they set
        # (e.g. future options) survive.
        opts["include_usage"] = True


def _extract_model(kwargs: dict[str, Any]) -> str:
    """Pull the model out of request kwargs. Used as a fallback when
    the response doesn't carry it (e.g. error before any chunk)."""
    m = kwargs.get("model", "")
    return str(m) if m else ""


def _accumulate_chunk(chunk: Any, chunks_text: list[str]) -> None:
    """Pull text out of a streaming chunk's choices[0].delta.content
    if present. Tolerates None / missing attributes from the SDK."""
    try:
        for choice in getattr(chunk, "choices", []) or []:
            delta = getattr(choice, "delta", None)
            if delta is None:
                continue
            content = getattr(delta, "content", None)
            if content:
                chunks_text.append(str(content))
    except Exception:  # noqa: BLE001
        # Never raise from instrumentation — a malformed chunk loses
        # this content but the trace still completes.
        pass


def _emit_nonstreaming(
    sdk: ScopeCallSDK,
    request_kwargs: dict[str, Any],
    response: Any,
    timestamp_ms: float,
    start_mono: float,
    ctx_snapshot: _context.TraceContext | None,
) -> None:
    """Pull tokens / output_text / finish_reason out of a non-streaming
    chat.completions response and emit an LLMEvent.

    openai-py 1.x response shape (verified against 1.51.x):
      response.model
      response.usage.prompt_tokens
      response.usage.completion_tokens
      response.usage.prompt_tokens_details.cached_tokens (optional)
      response.choices[0].message.content
      response.choices[0].finish_reason
      response.choices[0].message.tool_calls (optional)
    """
    latency_ms = int((time.monotonic() - start_mono) * 1000)

    model = getattr(response, "model", "") or _extract_model(request_kwargs)
    usage = getattr(response, "usage", None)
    input_tokens = getattr(usage, "prompt_tokens", 0) if usage else 0
    output_tokens = getattr(usage, "completion_tokens", 0) if usage else 0

    cache_read_tokens: int | None = None
    if usage is not None:
        details = getattr(usage, "prompt_tokens_details", None)
        if details is not None:
            cache_read_tokens = getattr(details, "cached_tokens", None)

    output_text = ""
    finish_reason: str | None = None
    tool_calls: Any = None
    choices = getattr(response, "choices", None) or []
    if choices:
        msg = getattr(choices[0], "message", None)
        if msg is not None:
            output_text = getattr(msg, "content", "") or ""
            tool_calls = getattr(msg, "tool_calls", None)
        finish_reason = getattr(choices[0], "finish_reason", None)

    input_text = extract_messages_text(request_kwargs.get("messages", []))

    event = build_llm_event(
        sdk,
        model=str(model),
        provider=PROVIDER,
        input_tokens=int(input_tokens or 0),
        output_tokens=int(output_tokens or 0),
        latency_ms=latency_ms,
        timestamp_ms=timestamp_ms,
        status="success",
        input_text=input_text,
        output_text=output_text,
        finish_reason=finish_reason,
        cache_read_tokens=cache_read_tokens,
        tool_calls=tool_calls_to_json(tool_calls),
        ctx_override=ctx_snapshot,
    )
    emit(sdk, event)


def _emit_from_stream(
    sdk: ScopeCallSDK,
    *,
    request_kwargs: dict[str, Any],
    model: str,
    usage: Any,
    output_text: str,
    finish_reason: str | None,
    timestamp_ms: float,
    latency_ms: int,
    ttft_ms: int | None,
    status: str,
    error_message: str | None,
    ctx_snapshot: _context.TraceContext | None,
) -> None:
    """Emit an LLMEvent assembled from streaming chunks.

    Usage extraction differs slightly from the non-streaming path
    because the chunk's `usage` object structure is identical (both are
    `CompletionUsage` instances in openai-py 1.x), but it's None unless
    include_usage=True was set on stream_options.
    """
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens: int | None = None
    if usage is not None:
        input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
        details = getattr(usage, "prompt_tokens_details", None)
        if details is not None:
            cache_read_tokens = getattr(details, "cached_tokens", None)

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
        finish_reason=finish_reason,
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
    """Emit an event for a call that raised before producing any response.

    Status is `"rate_limited"` for HTTP 429, `"timeout"` for httpx /
    asyncio timeouts, `"error"` for everything else — same shape the TS
    SDK uses. The TS SDK detects status via `err.status === 429`; we
    look at the exception's `status_code` attr (openai-py 1.x raises
    `APIStatusError` subclasses with that attribute) or the class name.
    """
    latency_ms = int((time.monotonic() - start_mono) * 1000)

    status_code = getattr(exc, "status_code", None)
    if status_code is None:
        status_code = getattr(exc, "status", None)

    if status_code == 429:
        status = "rate_limited"
    elif _is_timeout(exc):
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
        # No output — the call never produced one.
        output_text="",
        error_message=str(exc),
        ctx_override=ctx_snapshot,
    )
    emit(sdk, event)


def _is_timeout(exc: BaseException) -> bool:
    """Heuristic for "this exception was a timeout."

    Both openai-py's APITimeoutError and httpx's TimeoutException have
    "Timeout" in their class name. asyncio.TimeoutError likewise. We
    check the class name rather than isinstance-ing every concrete
    type because the timeout class hierarchy changes between openai-py
    minor versions and we want this to keep working.
    """
    return "Timeout" in type(exc).__name__
