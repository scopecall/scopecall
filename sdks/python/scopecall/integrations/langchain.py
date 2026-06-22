"""LangChain / LangChain-core integration for ScopeCall.

LangChain emits discrete callback events (``on_chain_start`` / ``on_llm_end``
…) rather than wrapping work in a ``with`` block, and those events can fire
on different threads. This adapter maps them to the ScopeCall span hierarchy
using the SDK's manual lifecycle primitives (``start_span`` / ``end_span``)
and a ``run_id``-keyed registry so nesting (``parent_run_id``) is preserved:

    chain  → agent span
    tool   → step span
    llm    → llm event (with token usage)

Usage::

    import scopecall
    from scopecall.integrations.langchain import ScopeCallCallbackHandler

    scopecall.init(api_key=..., endpoint=...)
    handler = ScopeCallCallbackHandler()      # or integrations.langchain.instrument()

    chain.invoke(inputs, config={"callbacks": [handler]})

Contract: no-op when ScopeCall is uninitialized; never raises into
LangChain; works whether or not ``langchain_core`` is installed (the base
class is imported lazily, with a duck-typed fallback).
"""

from __future__ import annotations

import threading
import time
from typing import Any

from .._sdk import get_active


def _base_handler_class():
    """Return langchain_core's BaseCallbackHandler, or a plain object base.

    We don't hard-depend on langchain. If it's installed we subclass the
    real base (so isinstance checks in LangChain pass); otherwise we fall
    back to ``object`` so the handler is still importable and testable.
    """
    try:  # pragma: no cover - depends on env
        from langchain_core.callbacks import BaseCallbackHandler

        return BaseCallbackHandler
    except Exception:  # pragma: no cover
        try:
            from langchain.callbacks.base import BaseCallbackHandler  # type: ignore

            return BaseCallbackHandler
        except Exception:
            return object


_Base = _base_handler_class()


class ScopeCallCallbackHandler(_Base):  # type: ignore[misc,valid-type]
    """LangChain callback handler that emits ScopeCall spans.

    Args:
        sdk: explicit SDK instance; defaults to ``scopecall.get_active()``
            resolved lazily per event.
        customer_id / prompt_version: optional attribution applied to spans
            opened by this handler.
    """

    # LangChain checks this attribute to decide whether to keep the handler
    # across nested runs; True keeps event delivery consistent.
    run_inline = False

    def __init__(self, sdk: Any | None = None, *, customer_id: str | None = None,
                 prompt_version: str | None = None, llm_only: bool = False) -> None:
        try:
            super().__init__()  # type: ignore[misc]
        except Exception:
            pass
        self._explicit_sdk = sdk
        self._customer_id = customer_id
        self._prompt_version = prompt_version
        # llm_only: only capture LLM token usage (+ dedup the raw provider
        # event), and DON'T open chain/tool container spans. Used by the auto
        # agent alongside the LangGraph node→agent patch, so chains aren't
        # double-counted as agents. Standalone LangChain apps leave it False
        # to get chain→agent / tool→step spans too.
        self._llm_only = llm_only
        self._lock = threading.Lock()
        # run_id -> TraceContext (for chain/tool container spans)
        self._spans: dict[Any, Any] = {}
        # run_id -> (parent_context, start_ms) for in-flight llm calls
        self._llm: dict[Any, tuple[Any, float]] = {}

    # ── helpers ────────────────────────────────────────────────────────

    def _sdk(self):
        try:
            return self._explicit_sdk if self._explicit_sdk is not None else get_active()
        except Exception:
            return None

    def _parent_ctx(self, parent_run_id):
        if parent_run_id is not None:
            with self._lock:
                return self._spans.get(parent_run_id)
        return None

    def _open(self, run_id, parent_run_id, name, kind):
        if self._llm_only:
            return  # container spans handled elsewhere (e.g. LangGraph patch)
        sdk = self._sdk()
        if sdk is None:
            return
        try:
            ctx = sdk.start_span(
                name,
                kind=kind,
                parent_context=self._parent_ctx(parent_run_id),
                customer_id=self._customer_id,
                prompt_version=self._prompt_version,
            )
            with self._lock:
                self._spans[run_id] = ctx
        except Exception:
            pass

    def _close(self, run_id, status="success", error_message=None):
        sdk = self._sdk()
        with self._lock:
            ctx = self._spans.pop(run_id, None)
        if sdk is None or ctx is None:
            return
        try:
            sdk.end_span(ctx, status=status, error_message=error_message)
        except Exception:
            pass

    # ── chain → agent ──────────────────────────────────────────────────

    def on_chain_start(self, serialized, inputs, *, run_id=None, parent_run_id=None, **kw):
        name = _name(serialized, kw, default="chain")
        self._open(run_id, parent_run_id, name, "agent")

    def on_chain_end(self, outputs, *, run_id=None, **kw):
        self._close(run_id)

    def on_chain_error(self, error, *, run_id=None, **kw):
        self._close(run_id, status="error", error_message=str(error)[:1000])

    # ── tool → step ────────────────────────────────────────────────────

    def on_tool_start(self, serialized, input_str, *, run_id=None, parent_run_id=None, **kw):
        name = _name(serialized, kw, default="tool")
        self._open(run_id, parent_run_id, name, "step")

    def on_tool_end(self, output, *, run_id=None, **kw):
        self._close(run_id)

    def on_tool_error(self, error, *, run_id=None, **kw):
        self._close(run_id, status="error", error_message=str(error)[:1000])

    # ── retriever → step (best-effort) ─────────────────────────────────

    def on_retriever_start(self, serialized, query, *, run_id=None, parent_run_id=None, **kw):
        self._open(run_id, parent_run_id, _name(serialized, kw, default="retriever"), "step")

    def on_retriever_end(self, documents, *, run_id=None, **kw):
        self._close(run_id)

    def on_retriever_error(self, error, *, run_id=None, **kw):
        self._close(run_id, status="error", error_message=str(error)[:1000])

    # ── llm → llm event ────────────────────────────────────────────────

    def on_llm_start(self, serialized, prompts, *, run_id=None, parent_run_id=None, **kw):
        # Resolve parent BEFORE taking the lock — _parent_ctx acquires the
        # same (non-reentrant) lock, so calling it inside would deadlock.
        parent = self._parent_ctx(parent_run_id)
        # Suppress the raw-provider event for the underlying call (which fires
        # between on_llm_start and on_llm_end) so THIS callback — which has
        # the reliable usage_metadata tokens — is the single source of truth.
        token = None
        try:
            from .. import _context
            token = _context.set_suppress_llm_emit(True)
        except Exception:
            pass
        with self._lock:
            self._llm[run_id] = (parent, time.time(), token)

    on_chat_model_start = on_llm_start  # chat models fire this variant

    def _unsuppress(self, token):
        if token is None:
            return
        try:
            from .. import _context
            _context.reset_suppress_llm_emit(token)
        except Exception:
            pass

    def on_llm_end(self, response, *, run_id=None, **kw):
        sdk = self._sdk()
        with self._lock:
            entry = self._llm.pop(run_id, None)
        parent_ctx, start, token = entry if entry else (None, time.time(), None)
        self._unsuppress(token)
        if sdk is None:
            return
        model, provider, in_tok, out_tok = _parse_llm_result(response)
        try:
            sdk.record_llm_call(
                model=model,
                provider=provider,
                input_tokens=in_tok,
                output_tokens=out_tok,
                latency_ms=int((time.time() - start) * 1000),
                status="success",
                context=parent_ctx,
                customer_id=self._customer_id,
                prompt_version=self._prompt_version,
            )
        except Exception:
            pass

    def on_llm_error(self, error, *, run_id=None, **kw):
        sdk = self._sdk()
        with self._lock:
            entry = self._llm.pop(run_id, None)
        parent_ctx, start, token = entry if entry else (None, time.time(), None)
        self._unsuppress(token)
        if sdk is None:
            return
        try:
            sdk.record_llm_call(
                model="unknown", provider="unknown", input_tokens=0, output_tokens=0,
                latency_ms=int((time.time() - start) * 1000), status="error",
                error_message=str(error)[:1000], context=parent_ctx,
                customer_id=self._customer_id, prompt_version=self._prompt_version,
            )
        except Exception:
            pass


def _name(serialized, kw, *, default):
    """Best-effort span name from LangChain's serialized payload."""
    try:
        if kw.get("name"):
            return str(kw["name"])
        if isinstance(serialized, dict):
            if serialized.get("name"):
                return str(serialized["name"])
            ident = serialized.get("id")
            if isinstance(ident, list) and ident:
                return str(ident[-1])
    except Exception:
        pass
    return default


def _parse_llm_result(response) -> tuple[str, str, int, int]:
    """Extract (model, provider, input_tokens, output_tokens) from an LLMResult."""
    model, provider, in_tok, out_tok = "unknown", "unknown", 0, 0
    try:
        out = getattr(response, "llm_output", None) or {}
        if isinstance(out, dict):
            model = out.get("model_name") or out.get("model") or model
            usage = out.get("token_usage") or out.get("usage") or {}
            if isinstance(usage, dict):
                in_tok = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
                out_tok = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
        # usage_metadata path (newer langchain): generations[0][0].message.usage_metadata
        if (in_tok == 0 and out_tok == 0):
            gens = getattr(response, "generations", None) or []
            for row in gens:
                for g in row:
                    msg = getattr(g, "message", None)
                    um = getattr(msg, "usage_metadata", None) if msg else None
                    if isinstance(um, dict):
                        in_tok = int(um.get("input_tokens") or 0)
                        out_tok = int(um.get("output_tokens") or 0)
                        break
        m = (model or "").lower()
        if "gpt" in m or "o1" in m or "o3" in m:
            provider = "openai"
        elif "claude" in m:
            provider = "anthropic"
        elif "gemini" in m:
            provider = "google"
    except Exception:
        pass
    return model or "unknown", provider, in_tok, out_tok


def instrument(sdk: Any | None = None, **kwargs) -> ScopeCallCallbackHandler:
    """Return a configured handler. Pass via ``config={"callbacks": [handler]}``."""
    return ScopeCallCallbackHandler(sdk=sdk, **kwargs)
