"""Trace context — `contextvars` propagation so nested `sdk.trace()` blocks
chain correctly through sync code, async code, FastAPI request handlers,
asyncio tasks, and background workers.

Why `contextvars` (PEP 567) and not threadlocals: thread-locals don't
propagate across `await` boundaries by default. `contextvars.ContextVar`
DOES propagate across `await` and into `asyncio.create_task()`, which is
the table-stakes property for any AI backend using `AsyncOpenAI` /
`AsyncAnthropic`. The reviewer correctly called this out as a P0.

Each `sdk.trace(name)` call:

  1. Generates a new `span_id` for itself.
  2. Reads the current `_current_trace` ContextVar (if any) to find the
     parent's `trace_id` + `span_id`. If there is one, inherit
     `trace_id`; otherwise mint a fresh one.
  3. Sets the new `TraceContext` as `_current_trace` for the body of the
     block.
  4. Resets `_current_trace` on exit so nesting unwinds cleanly.

The block ALSO emits a synthetic workflow event on exit — see
`scopecall._sdk.ScopeCallSDK.trace` for the call site. The event is
what the dashboard's Flow Map and trace tree render as the parent
"workflow" node. Without it, child LLM rows would have a
`parent_span_id` that points at nothing in ClickHouse, and the
flow-map JOIN finds no parent.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field


@dataclass
class TraceContext:
    """The state a single `sdk.trace()` block carries.

    The instance is what `with sdk.trace(...) as ctx:` yields — users can
    read these fields to add custom span IDs, parent linkage etc. in
    bespoke instrumentation.
    """

    # Stable across the whole trace tree (one trace = many spans).
    trace_id: str

    # Unique per `sdk.trace()` block. Children inside reference this as
    # their `parent_span_id`.
    span_id: str

    # The PARENT trace's span_id, if this block is nested inside another
    # `sdk.trace()`. None at the root.
    parent_span_id: str | None

    # The block's human label. Doubles as the default feature_name on the
    # synthetic workflow event we emit on block exit. The reviewer's
    # FastAPI example was `sdk.trace("chat-api", ...)` — that string ends
    # up as feature_name='chat-api' on the workflow row.
    name: str | None

    # Per-trace prompt_version. None at this level means "inherit from
    # config.default_prompt_version". The TS SDK does the same precedence:
    # trace's value → parent trace's value → config default → None.
    prompt_version: str | None = None

    # Per-trace overrides for user/session/feature. None means "inherit
    # config defaults at event-emission time."
    user_id: str | None = None
    session_id: str | None = None
    feature_name: str | None = None

    # Wall-clock start time (ms epoch). Used to compute the workflow
    # span's latency when the block exits.
    start_time_ms: float = field(default=0.0)


# Module-level ContextVar. The reset-token pattern below is what
# guarantees nested traces unwind in the right order even when the user
# raises an exception inside the body.
_current_trace: ContextVar[TraceContext | None] = ContextVar(
    "scopecall_current_trace", default=None
)


def get_current() -> TraceContext | None:
    """Return the innermost active TraceContext, or None at the root.

    Provider instrumentations (chunk 2) call this to discover the parent
    span for an outgoing LLM event. Manual API helpers (`sdk.span`,
    `sdk.record_llm_call`) do the same.
    """
    return _current_trace.get()


def push(ctx: TraceContext) -> object:
    """Set `ctx` as the current trace and return a token.

    The caller is responsible for `pop(token)` in a finally block. The
    SDK's `trace()` context manager does this — manual callers usually
    don't need to touch push/pop directly.
    """
    return _current_trace.set(ctx)


def pop(token: object) -> None:
    """Restore the previous TraceContext using the token from `push`.

    `ContextVar.reset()` is the right primitive here because it's
    exception-safe: reseting always succeeds even if the token's
    var-binding was overridden by intermediate `set` calls in the
    interim. We type the parameter as `object` because the actual
    `Token` class isn't easily constructible in user code and exposing
    it would invite accidental forgery.
    """
    _current_trace.reset(token)  # type: ignore[arg-type]


def new_span_id() -> str:
    """Mint a 16-hex-char span ID (matches the OTel + TS SDK convention).

    OTel uses 8-byte span IDs rendered as 16 hex chars. We follow the
    same shape so trace IDs are interoperable when an OTel bridge ships
    in v0.2.x.
    """
    return uuid.uuid4().hex[:16]


def new_trace_id() -> str:
    """Mint a 32-hex-char trace ID (matches OTel + TS SDK convention)."""
    return uuid.uuid4().hex
