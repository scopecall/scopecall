"""CrewAI integration for ScopeCall.

CrewAI expresses orchestration as Agents executing Tasks. This adapter
wraps those execution entry points so each becomes a ScopeCall ``agent``
span — full crew orchestration visibility with one call:

    import scopecall
    from scopecall.integrations import crewai as sc_crewai

    scopecall.init(api_key=..., endpoint=...)
    sc_crewai.instrument()      # once, before kicking off the crew

LLM calls made inside a task (via instrumented OpenAI/Anthropic clients or
the LangChain handler) attribute to the enclosing agent span.

Contract: no-op if crewai isn't installed or ScopeCall is uninitialized;
never raises; idempotent.
"""

from __future__ import annotations

from typing import Any

from ._base import span_callable

# (class, method-name) pairs we attempt to wrap. CrewAI's internals have
# shifted across versions, so we try several and wrap whatever exists.
_TARGETS = [
    ("crewai.agent", "Agent", "execute_task"),
    ("crewai", "Agent", "execute_task"),
    ("crewai.task", "Task", "execute_sync"),
    ("crewai.task", "Task", "execute"),
]

_patched: list[tuple[type, str, Any]] = []


def _agent_name_from_args(method_name, args, kwargs) -> str:
    """Derive a readable span name from the bound instance / task."""
    try:
        inst = args[0] if args else None
        role = getattr(inst, "role", None) or getattr(inst, "name", None)
        if role:
            return f"crewai:{role}"
        if inst is not None:
            return f"crewai:{type(inst).__name__}"
    except Exception:
        pass
    return f"crewai:{method_name}"


def instrument(sdk: Any | None = None) -> bool:
    """Wrap CrewAI Agent/Task execution as ScopeCall agent spans.

    Returns True if at least one target was patched, False otherwise.
    """
    import importlib

    sdk_getter = (lambda: sdk) if sdk is not None else None
    any_patched = False

    for module_path, class_name, method_name in _TARGETS:
        try:
            mod = importlib.import_module(module_path)
            cls = getattr(mod, class_name, None)
            if cls is None:
                continue
            original = getattr(cls, method_name, None)
            if original is None or getattr(original, "__scopecall_instrumented__", False):
                continue

            def make_wrapper(orig, mname):
                def wrapper(self, *args, **kwargs):
                    name = _agent_name_from_args(mname, (self,) + args, kwargs)
                    wrapped = span_callable(
                        lambda: orig(self, *args, **kwargs),
                        name=name, kind="agent", sdk_getter=sdk_getter,
                    )
                    return wrapped()
                wrapper.__scopecall_instrumented__ = True
                wrapper.__name__ = getattr(orig, "__name__", mname)
                return wrapper

            setattr(cls, method_name, make_wrapper(original, method_name))
            _patched.append((cls, method_name, original))
            any_patched = True
        except Exception:
            continue

    return any_patched


def uninstrument() -> None:
    """Restore original CrewAI methods (mainly for tests)."""
    while _patched:
        cls, method_name, original = _patched.pop()
        try:
            setattr(cls, method_name, original)
        except Exception:
            pass
