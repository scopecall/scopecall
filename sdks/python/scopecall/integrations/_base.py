"""Framework-agnostic building blocks shared by all ScopeCall adapters.

The single most reusable primitive is :func:`span_callable`, which wraps an
arbitrary callable so that invoking it opens a ScopeCall span (agent by
default) around its execution. Framework adapters compose this:

  * LangGraph wraps each node callable as an ``agent`` span.
  * CrewAI wraps each agent/task ``execute`` as an ``agent`` span.
  * A generic ``@traced_agent`` decorator wraps any function.

All helpers degrade to a transparent passthrough when ScopeCall is not
initialized, and never raise into the host framework.
"""

from __future__ import annotations

import functools
from typing import Any, Callable

from .._sdk import get_active


def _resolve_sdk(sdk_getter: Callable[[], Any] | None):
    """Return an SDK instance (explicit getter wins, else the active one)."""
    try:
        if sdk_getter is not None:
            return sdk_getter()
        return get_active()
    except Exception:  # pragma: no cover - defensive
        return None


def span_callable(
    fn: Callable,
    *,
    name: str | None = None,
    kind: str = "agent",
    sdk_getter: Callable[[], Any] | None = None,
) -> Callable:
    """Wrap ``fn`` so each call runs inside a ScopeCall span.

    Args:
        fn: the callable to wrap (a framework node / task / handler).
        name: span name; defaults to ``fn.__name__``.
        kind: ``"workflow" | "agent" | "step"`` — which span method to open.
        sdk_getter: optional zero-arg callable returning the SDK; defaults
            to ``scopecall.get_active()`` resolved lazily at call time (so
            wrapping can happen before ``init()``).

    The wrapped callable:
      * resolves the SDK lazily on each invocation (works regardless of
        init ordering — frameworks build graphs before the app calls init);
      * uses the ambient context as parent, so a node invoked inside the
        run's workflow span becomes an agent under it;
      * is a transparent passthrough when ScopeCall is uninitialized;
      * never lets an instrumentation error escape into the framework.

    Idempotent: wrapping an already-wrapped callable returns it unchanged.
    """
    if getattr(fn, "__scopecall_instrumented__", False):
        return fn

    span_name = name or getattr(fn, "__name__", kind)

    @functools.wraps(fn)
    def _wrapped(*args, **kwargs):
        sdk = _resolve_sdk(sdk_getter)
        opener = getattr(sdk, kind, None) if sdk is not None else None
        if opener is None:
            return fn(*args, **kwargs)
        try:
            cm = opener(span_name)
        except Exception:  # pragma: no cover - defensive
            return fn(*args, **kwargs)
        with cm:
            return fn(*args, **kwargs)

    _wrapped.__scopecall_instrumented__ = True
    return _wrapped


def traced_agent(name: str | None = None, *, kind: str = "agent"):
    """Decorator form of :func:`span_callable` for hand-instrumenting any
    function as a span — the universal escape hatch for frameworks without
    a dedicated adapter::

        @traced_agent("router")
        def route(state): ...
    """
    def _decorator(fn: Callable) -> Callable:
        return span_callable(fn, name=name, kind=kind)

    return _decorator
