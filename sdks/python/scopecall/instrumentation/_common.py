"""Shared helpers across provider instrumentations.

What lives here:
  - `build_llm_event(sdk, ...)` — assembles an LLMEvent from raw call
    data, applies the redactor, resolves trace context, fills in
    config defaults, and enqueues it. Both _openai.py and
    _anthropic.py funnel through this so the wire shape, redaction,
    and context resolution are identical regardless of provider.
  - `extract_input_text(messages)` — flatten OpenAI / Anthropic
    "messages" arrays into the single string the wire format wants.

Why this file exists rather than methods on ScopeCallSDK: each
instrumentation is a thin adapter from a provider-specific response to
our wire shape. Centralising the resolve-context + emit logic here
keeps `_sdk.py` focused on the public API surface, and keeps the
provider files focused on "how to read this provider's response."
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any

from .. import _context
from .._version import __version__
from ..wire._event import LLMEvent

if TYPE_CHECKING:
    from .._sdk import ScopeCallSDK


def apply_redaction(
    sdk: ScopeCallSDK,
    input_text: str | None,
    output_text: str | None,
) -> tuple[str | None, str | None]:
    """Apply the SDK's redactor + capture_content policy to a pair of
    text fields. Shared between `build_llm_event` (provider wrappers)
    and `ScopeCallSDK.record_llm_call` (manual API) so both paths
    produce identical wire output for the same input.

    Round-12 review P0a: `record_llm_call` previously constructed
    LLMEvent directly and skipped redaction, contradicting the
    "redact_pii=True scrubs input/output before leaving the process"
    promise for manual-instrumentation callers (LangChain / LlamaIndex
    / custom wrappers). Extracted here so both code paths use the
    same logic instead of one duplicating the other.
    """
    if not sdk._config.capture_content:
        # capture_content=False overrides any inputs — Round-2 wire
        # contract: None means "SDK didn't capture", "" means "empty".
        return None, None

    redactor = sdk._redactor
    if redactor is None:
        return input_text, output_text

    if input_text:
        input_text = redactor.redact(input_text)
    if output_text:
        output_text = redactor.redact(output_text)
    return input_text, output_text


def build_llm_event(
    sdk: ScopeCallSDK,
    *,
    model: str,
    provider: str,
    input_tokens: int,
    output_tokens: int,
    latency_ms: int,
    timestamp_ms: float,
    status: str = "success",
    ttft_ms: int | None = None,
    input_text: str | None = None,
    output_text: str | None = None,
    finish_reason: str | None = None,
    cache_read_tokens: int | None = None,
    error_message: str | None = None,
    tool_calls: str | None = None,
    extra: str | None = None,
    ctx_override: _context.TraceContext | None = None,
) -> LLMEvent:
    """Construct an LLMEvent and apply context + redactor + config defaults.

    The single source of truth for "given raw call data, what LLMEvent do
    we emit?" — provider instrumentations call this with whatever they
    were able to extract from the response.

    Resolves trace context inline so the caller doesn't have to: if
    we're inside an `sdk.trace()` block, `parent_span_id` and the
    inherited feature/user/session/prompt_version chain are set
    automatically. Outside a trace, the event is a top-level orphan
    (parent_span_id = None, trace_id minted fresh).

    `ctx_override` exists for the streaming case (Round-12 review P0b):
    streaming wrappers capture the active context at create() time and
    pass it back here when the stream is consumed — even if the stream
    is iterated AFTER the enclosing `sdk.trace()` block has exited.
    Without it, late stream consumption produces an orphan LLM event
    with no `parent_span_id`. Non-streaming paths can ignore this and
    rely on `_context.get_current()` because they emit synchronously
    inside the active context.
    """
    config = sdk._config

    # ── Redact content if configured ─────────────────────────────────
    # Run BOTH input and output through the same redactor pass — the
    # symmetry is important. Round-1 review caught a case where input
    # was redacted but output wasn't, leaking a credit card number
    # that the model echoed back from a prompt.
    input_text, output_text = apply_redaction(sdk, input_text, output_text)

    # ── Resolve trace context ────────────────────────────────────────
    # ctx_override takes precedence (set by streaming wrappers that
    # captured at create()-time); otherwise read the live contextvar.
    ctx = ctx_override if ctx_override is not None else _context.get_current()
    trace_id = ctx.trace_id if ctx else _context.new_trace_id()
    parent_span_id = ctx.span_id if ctx else None

    # Per-event identity dimensions: trace context wins over config
    # default (matches sdk.record_llm_call() precedence).
    feature_name = (ctx.feature_name if ctx else None) or config.default_feature
    user_id = (ctx.user_id if ctx else None) or config.default_user_id
    session_id = (ctx.session_id if ctx else None) or config.default_session_id
    prompt_version = (
        (ctx.prompt_version if ctx else None) or config.default_prompt_version
    )

    return LLMEvent(
        trace_id=trace_id,
        span_id=_context.new_span_id(),
        parent_span_id=parent_span_id,
        timestamp=timestamp_ms,
        latency_ms=latency_ms,
        ttft_ms=ttft_ms,
        model=model,
        provider=provider,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        # cost_usd is advisory — the Rust processor recomputes from the
        # bundled pricing table. Leaving it at 0.0 here makes the
        # debug/console path show "we don't know the cost yet" rather
        # than a stale guess.
        cost_usd=0.0,
        status=status,
        error_message=error_message,
        input_text=input_text,
        output_text=output_text,
        feature_name=feature_name,
        user_id=user_id,
        session_id=session_id,
        environment=config.environment,
        sdk_version=__version__,
        extra=extra,
        finish_reason=finish_reason,
        cache_read_tokens=cache_read_tokens,
        tool_calls=tool_calls,
        prompt_version=prompt_version,
        kind="llm",
    )


def emit(sdk: ScopeCallSDK, event: LLMEvent) -> None:
    """Send a built event to the exporter. Single chokepoint so a
    future logging / sampling layer has one place to hook in."""
    sdk._exporter.enqueue(event)


def now_ms() -> float:
    """Wall-clock millis. We use time.time() (not time.monotonic) for
    `timestamp` because the dashboard needs absolute time; for
    `latency_ms` and `ttft_ms` we use monotonic to avoid clock-skew
    artifacts during NTP adjustments."""
    return time.time() * 1000.0


def extract_messages_text(messages: Any) -> str:
    """Flatten an OpenAI / Anthropic 'messages' array into a single
    string for the wire format.

    Both providers use a similar shape:
        messages=[
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello"},
        ]
    Anthropic also supports content arrays:
        {"role": "user", "content": [{"type": "text", "text": "Hi"}]}

    We render as:
        user: Hi
        assistant: Hello

    Conservative: if the structure isn't recognisable, return an empty
    string rather than risk leaking a stringified object dump.
    """
    if not messages:
        return ""
    parts: list[str] = []
    try:
        for msg in messages:
            if not isinstance(msg, dict):
                # openai-py SDK uses TypedDict instances at runtime;
                # they ARE dicts. anthropic-py too. If someone passes
                # arbitrary objects we render their repr conservatively.
                parts.append(str(msg))
                continue
            role = msg.get("role", "")
            content = msg.get("content", "")
            if isinstance(content, str):
                parts.append(f"{role}: {content}")
            elif isinstance(content, list):
                # Anthropic content blocks: [{"type": "text", "text": "..."}, ...]
                texts: list[str] = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        texts.append(str(block.get("text", "")))
                if texts:
                    parts.append(f"{role}: " + "\n".join(texts))
    except Exception:  # noqa: BLE001
        # Never raise from instrumentation. Conservative fallback.
        return ""
    return "\n".join(parts)


def tool_calls_to_json(tool_calls: Any) -> str | None:
    """Serialize a tool_calls list to a JSON string for the wire.

    Both providers expose tool calls as a list of dict-like objects.
    We stringify defensively — if the provider response object isn't
    JSON-serializable (e.g. a pydantic model), fall back to repr.
    """
    if not tool_calls:
        return None
    try:
        return json.dumps(tool_calls, default=str)
    except Exception:  # noqa: BLE001
        try:
            return str(tool_calls)
        except Exception:  # noqa: BLE001
            return None
