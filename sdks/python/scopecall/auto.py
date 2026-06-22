"""scopecall.auto — zero-config auto-instrumentation (New Relic / Datadog style).

Put this at the very top of your application, before importing your LLM
libraries::

    import scopecall.auto          # <-- the only line you add
    # ... the rest of your app ...

With ``SCOPECALL_API_KEY`` set in the environment, it:
  1. **Auto-inits** the SDK from env (no ``init()`` call).
  2. **Auto-instruments on import** — via post-import hooks, the moment your
     app imports ``openai`` / ``anthropic`` / ``google.generativeai`` /
     ``langgraph``, each is patched. Every client/model is traced with NO
     per-client ``instrument()`` call.
  3. **Auto-root-span** — LangGraph ``invoke`` is wrapped in a workflow span
     so the whole run is one trace (agents nest under it automatically).

Everything is a no-op when ``SCOPECALL_API_KEY`` is unset. The explicit API
(``scopecall.init`` / ``sdk.instrument`` / ``sdk.workflow``) still works and
composes — auto is the convenience layer, not a replacement.

Env vars: SCOPECALL_API_KEY (required to enable), SCOPECALL_ENDPOINT,
SCOPECALL_ENV, SCOPECALL_TEST, SCOPECALL_DEBUG (console transport),
SCOPECALL_OUTPUT (NDJSON file).

Full auto-on-import needs ``wrapt`` (``pip install scopecall-py[auto]``).
Without it, only already-imported modules are patched (so import order
matters); a one-time notice is printed.
"""

from __future__ import annotations

import inspect
import os
import sys
from typing import Any, Callable

from . import _context, _sdk

try:  # wrapt powers post-import hooks (patch a lib the moment it's imported)
    import wrapt as _wrapt
except Exception:  # pragma: no cover
    _wrapt = None

_bootstrapped = False


def _truthy(v: str | None) -> bool:
    return (v or "").strip().lower() in ("1", "true", "yes", "on")


def _ensure_sdk():
    """Init (or reuse) the SDK from env. Returns None when disabled."""
    sdk = _sdk.get_active()
    if sdk is not None:
        return sdk
    api_key = os.getenv("SCOPECALL_API_KEY")
    debug = _truthy(os.getenv("SCOPECALL_DEBUG"))
    output = os.getenv("SCOPECALL_OUTPUT")
    if not api_key and not debug and not output:
        return None  # disabled: nothing to send to
    try:
        kwargs: dict[str, Any] = {}
        if api_key:
            kwargs["api_key"] = api_key
            kwargs["endpoint"] = os.getenv("SCOPECALL_ENDPOINT", "http://localhost:8080/v1/ingest")
        if debug:
            kwargs["debug"] = True
        if output:
            kwargs["output"] = output
        if os.getenv("SCOPECALL_ENV"):
            kwargs["environment"] = os.getenv("SCOPECALL_ENV")
        if _truthy(os.getenv("SCOPECALL_TEST")):
            kwargs["test"] = True
        return _sdk.init(**kwargs)
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[scopecall.auto] init failed, disabled: {exc}")
        return None


def _safe(fn: Callable, *a: Any) -> None:
    try:
        fn(*a)
    except Exception:  # pragma: no cover - never break the host import
        pass


# ── per-library patchers ─────────────────────────────────────────────────────

def _patch_openai(mod: Any, sdk: Any) -> None:
    from .instrumentation._openai import instrument_openai
    _patch_client_classes(mod, ("OpenAI", "AsyncOpenAI"), instrument_openai, sdk)


def _patch_anthropic(mod: Any, sdk: Any) -> None:
    from .instrumentation._anthropic import instrument_anthropic
    _patch_client_classes(mod, ("Anthropic", "AsyncAnthropic"), instrument_anthropic, sdk)


def _patch_client_classes(mod: Any, class_names: tuple[str, ...], instr: Callable, sdk: Any) -> None:
    """Wrap each client class's __init__ so every constructed instance is
    auto-instrumented — the OpenAI/Anthropic equivalent of New Relic's
    per-connection patching."""
    for name in class_names:
        cls = getattr(mod, name, None)
        if cls is None or getattr(cls, "_scopecall_auto", False):
            continue
        orig_init = cls.__init__

        def make(orig_init: Callable) -> Callable:
            def __init__(self: Any, *a: Any, **k: Any) -> None:
                orig_init(self, *a, **k)
                _safe(instr, self, sdk)
            return __init__

        cls.__init__ = make(orig_init)
        cls._scopecall_auto = True


def _patch_gemini(mod: Any, sdk: Any) -> None:
    from .instrumentation._gemini import instrument_gemini_module
    instrument_gemini_module(mod, sdk)


# Kept module-global so the ContextVar isn't garbage-collected.
_lc_handler_var: Any = None


def _patch_langchain_callbacks(mod: Any, sdk: Any) -> None:
    """Attach a global LangChain callback handler (llm_only) so LLM calls
    routed through LangChain (e.g. ChatOpenAI) get their token usage from the
    reliable `usage_metadata` on the LangChain response — the raw provider
    patch is suppressed for those calls to avoid a duplicate. Agent/chain
    spans are left to the LangGraph patch, so nothing double-counts."""
    global _lc_handler_var
    if _lc_handler_var is not None:
        return
    try:
        from langchain_core.tracers.context import register_configure_hook
    except Exception:
        return
    try:
        import contextvars
        from .integrations.langchain import ScopeCallCallbackHandler

        var = contextvars.ContextVar("scopecall_lc_handler", default=None)
        register_configure_hook(var, True)  # inheritable → attached to every run
        var.set(ScopeCallCallbackHandler(sdk, llm_only=True))
        _lc_handler_var = var
    except Exception:
        pass


def _patch_thread_context_propagation() -> None:
    """Make `contextvars` cross `ThreadPoolExecutor` boundaries.

    Auto-instrumentation finds a call's parent span via the active
    contextvar. But Python does NOT copy contextvars into worker threads,
    so any app that fans LLM calls out across a thread pool (parallel model
    calls, multi-agent consensus, map-style batching) would orphan every
    threaded call — fresh trace, no parent, no customer_id.

    We patch `ThreadPoolExecutor.submit` to snapshot the submitting
    thread's context (`copy_context()`) and run the task inside it. This is
    the same technique ddtrace / OpenTelemetry use. It nests correctly: a
    task that itself submits to another pool propagates the context it was
    given, so deeply-nested pools (chunk-thread → model-call-thread) all
    keep the right span. Idempotent; safe process-wide.
    """
    import concurrent.futures as _cf
    import contextvars

    Ex = _cf.ThreadPoolExecutor
    if getattr(Ex, "_scopecall_auto_ctx", False):
        return
    orig_submit = Ex.submit

    def submit(self: Any, fn: Callable, /, *args: Any, **kwargs: Any) -> Any:
        ctx = contextvars.copy_context()
        return orig_submit(self, lambda: ctx.run(fn, *args, **kwargs))

    Ex.submit = submit  # type: ignore[method-assign]
    Ex._scopecall_auto_ctx = True


def _patch_langgraph(mod: Any, sdk: Any) -> None:
    # Auto-agent per node (patches StateGraph.add_node).
    try:
        from .integrations import langgraph as lg
        lg.instrument(sdk)
    except Exception:  # pragma: no cover
        pass
    # Auto-root-span: wrap compiled-graph invoke/ainvoke in a workflow span so
    # the run is a single trace and the auto-agents nest under it.
    _patch_langgraph_invoke(sdk)


def _patch_langgraph_invoke(sdk: Any) -> None:
    try:
        from langgraph.pregel import Pregel  # compiled graphs subclass this
    except Exception:  # pragma: no cover - version/layout differences
        return
    if getattr(Pregel, "_scopecall_auto", False):
        return
    orig = getattr(Pregel, "invoke", None)
    if orig is not None:
        def invoke(self: Any, *a: Any, **k: Any) -> Any:
            # Don't double-wrap: if the app already opened a workflow/agent
            # span (e.g. to set a customer_id), nest under it instead of
            # adding a generic "langgraph" root.
            if _context.get_current() is not None:
                return orig(self, *a, **k)
            with sdk.workflow("langgraph"):
                return orig(self, *a, **k)
        Pregel.invoke = invoke
    orig_a = getattr(Pregel, "ainvoke", None)
    if orig_a is not None and inspect.iscoroutinefunction(orig_a):
        async def ainvoke(self: Any, *a: Any, **k: Any) -> Any:
            if _context.get_current() is not None:
                return await orig_a(self, *a, **k)
            with sdk.workflow("langgraph"):
                return await orig_a(self, *a, **k)
        Pregel.ainvoke = ainvoke
    Pregel._scopecall_auto = True


_TARGETS: list[tuple[str, Callable]] = [
    ("openai", _patch_openai),
    ("anthropic", _patch_anthropic),
    ("google.generativeai", _patch_gemini),
    ("langgraph.graph", _patch_langgraph),
    ("langchain_core", _patch_langchain_callbacks),
]


def _register(name: str, fn: Callable, sdk: Any) -> None:
    if _wrapt is not None:
        # Fires immediately if already imported, and on future import.
        _wrapt.register_post_import_hook(lambda m: _safe(fn, m, sdk), name)
    else:
        mod = sys.modules.get(name)
        if mod is not None:
            _safe(fn, mod, sdk)


def bootstrap() -> bool:
    """Idempotent. Returns True if auto-instrumentation is active."""
    global _bootstrapped
    if _bootstrapped:
        return True
    sdk = _ensure_sdk()
    if sdk is None:
        return False  # no key → fully disabled, host app untouched
    # Cross-thread context propagation FIRST — so threaded LLM calls (the
    # nested-ThreadPoolExecutor consensus pattern) attribute to their span
    # instead of orphaning.
    _safe(_patch_thread_context_propagation)
    for name, fn in _TARGETS:
        _register(name, fn, sdk)
    _bootstrapped = True
    if _wrapt is None:
        print(
            "[scopecall.auto] enabled (limited: install 'scopecall-py[auto]' "
            "for full auto-on-import; without wrapt only already-imported "
            "libraries are patched)"
        )
    else:
        print("[scopecall.auto] enabled — openai / anthropic / gemini / langgraph auto-instrumented")
    return True


# Run on import — that's the whole point of `import scopecall.auto`.
bootstrap()
