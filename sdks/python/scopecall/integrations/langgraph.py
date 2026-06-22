"""LangGraph integration for ScopeCall.

One call auto-derives the agent orchestration from a LangGraph graph: every
node becomes a ScopeCall ``agent`` span under the run's workflow, so the
full orchestration (and per-node / flow-level cost) shows up on the
dashboard with no per-node edits.

Usage::

    import scopecall
    from scopecall.integrations import langgraph as sc_langgraph

    sdk = scopecall.init(api_key=..., endpoint=...)
    sc_langgraph.instrument()          # call once, before building graphs

    # ... build your StateGraph as usual; nodes are auto-wrapped ...
    with sdk.workflow("my_run", customer_id=tenant):
        app.invoke(state)

`instrument()` monkey-patches ``StateGraph.add_node`` so that any node
callable registered afterward is wrapped in an agent span. It is:
  * **idempotent** — calling it repeatedly patches once;
  * **lazy** — the SDK is resolved when a node *runs*, not when patched, so
    init ordering doesn't matter;
  * **safe** — a no-op if LangGraph isn't installed, and node wrapping
    never raises into the graph.

For explicit, non-global wrapping use :func:`agent_node`.
"""

from __future__ import annotations

from typing import Any, Callable

from ._base import span_callable


def agent_node(name: str, fn: Callable, *, sdk_getter: Callable[[], Any] | None = None) -> Callable:
    """Wrap a single LangGraph node callable as an agent span.

    Explicit alternative to global :func:`instrument` — register with
    ``workflow.add_node(name, agent_node(name, fn))``.
    """
    return span_callable(fn, name=name, kind="agent", sdk_getter=sdk_getter)


def _split_name_action(args: tuple, kwargs: dict):
    """Resolve (name, action, locator) across LangGraph add_node signatures.

    Supports:
      * add_node(name: str, action: callable)
      * add_node(action: callable)                 # name = action.__name__
      * add_node(name, action=callable)            # action as kwarg
    Returns (name, action, locator) where locator tells the caller how to
    put a replacement back: ("arg", index) or ("kwarg", "action"). Returns
    (None, None, None) when the action isn't a plain callable we can wrap.
    """
    # action passed as kwarg
    if "action" in kwargs and callable(kwargs["action"]):
        name = args[0] if args and isinstance(args[0], str) else getattr(kwargs["action"], "__name__", None)
        return name, kwargs["action"], ("kwarg", "action")

    if args:
        # add_node(name, action)
        if isinstance(args[0], str) and len(args) >= 2 and callable(args[1]):
            return args[0], args[1], ("arg", 1)
        # add_node(action)
        if callable(args[0]):
            return getattr(args[0], "__name__", None), args[0], ("arg", 0)

    return None, None, None


def instrument(sdk: Any | None = None) -> bool:
    """Globally auto-instrument LangGraph nodes as ScopeCall agent spans.

    Returns True if patching is in effect (now or already), False if
    LangGraph isn't importable. Pass ``sdk`` to pin a specific instance;
    omit it to resolve ``scopecall.get_active()`` lazily at node-run time.
    """
    try:
        from langgraph.graph import StateGraph
    except Exception:
        return False

    if getattr(StateGraph, "__scopecall_instrumented__", False):
        return True

    original_add_node = StateGraph.add_node
    sdk_getter = (lambda: sdk) if sdk is not None else None

    def add_node(self, *args, **kwargs):
        try:
            name, action, locator = _split_name_action(args, kwargs)
            if action is not None and not getattr(action, "__scopecall_instrumented__", False):
                wrapped = agent_node(name or "node", action, sdk_getter=sdk_getter)
                kind, key = locator
                if kind == "arg":
                    args = tuple(wrapped if i == key else a for i, a in enumerate(args))
                else:
                    kwargs = {**kwargs, key: wrapped}
        except Exception:  # pragma: no cover - never break graph construction
            pass
        return original_add_node(self, *args, **kwargs)

    StateGraph.add_node = add_node
    StateGraph.__scopecall_instrumented__ = True
    StateGraph.__scopecall_original_add_node__ = original_add_node
    return True


def uninstrument() -> None:
    """Restore the original ``StateGraph.add_node`` (mainly for tests)."""
    try:
        from langgraph.graph import StateGraph
    except Exception:
        return
    orig = getattr(StateGraph, "__scopecall_original_add_node__", None)
    if orig is not None:
        StateGraph.add_node = orig
        StateGraph.__scopecall_instrumented__ = False
        delattr(StateGraph, "__scopecall_original_add_node__")
