"""Google Gemini (`google-generativeai`) instrumentation.

Unlike OpenAI / Anthropic (which expose a client instance), Gemini's API is
`genai.GenerativeModel(name).generate_content(...)` — there's no client to
hand to `instrument()`. So we patch `GenerativeModel.generate_content` (and
`generate_content_async`) at the CLASS level, which covers every model
instance the app constructs.

Covered:
  - GenerativeModel.generate_content(...)            — sync, non-streaming
  - GenerativeModel.generate_content_async(...)      — async, non-streaming
Streaming (stream=True) is passed through untouched for now (the chunk
protocol differs); the call still works, it just isn't traced.

Response shape (google-generativeai 0.7.x):
  response.text
  response.usage_metadata.prompt_token_count
  response.usage_metadata.candidates_token_count
  response.candidates[0].finish_reason
"""

from __future__ import annotations

import inspect
import time
from typing import TYPE_CHECKING, Any

from .. import _context
from ._common import build_llm_event, emit, now_ms

if TYPE_CHECKING:
    from .._sdk import ScopeCallSDK

PROVIDER = "google"
_PATCHED = "_scopecall_instrumented"

# The Gemini API returns finish_reason as an enum/int. The dashboard's
# truncation analyzer keys off the STRING names, so normalize here. Codes per
# the google.ai.generativelanguage FinishReason enum.
_FINISH_REASONS = {
    0: "FINISH_REASON_UNSPECIFIED",
    1: "STOP",
    2: "MAX_TOKENS",
    3: "SAFETY",
    4: "RECITATION",
    5: "OTHER",
}


def _normalize_finish_reason(fr: Any) -> str | None:
    """Map Gemini's finish_reason to its canonical string name.

    Accepts an enum (uses `.name`, e.g. FinishReason.MAX_TOKENS -> "MAX_TOKENS"),
    an int or int-like string (1 -> "STOP", 2 -> "MAX_TOKENS", ...), or an
    already-normalized string ("STOP" passes through unchanged). Returns None
    for None. Previously this stored the raw "1"/"2", which made truncation
    (MAX_TOKENS) undetectable downstream."""
    if fr is None:
        return None
    # Enum path: google's FinishReason / protobuf enums expose `.name`.
    name = getattr(fr, "name", None)
    if isinstance(name, str) and name:
        return name
    # Int (or digit string) path: map the numeric code to a canonical name.
    try:
        return _FINISH_REASONS.get(int(fr), str(fr))
    except (TypeError, ValueError):
        return str(fr)


def instrument_gemini(model_or_module: Any, sdk: ScopeCallSDK) -> None:
    """Instrument Gemini. Accepts either the `google.generativeai` module or
    a `GenerativeModel` instance; in both cases the `GenerativeModel` class
    is patched (so all instances are traced). Idempotent."""
    GenerativeModel = getattr(model_or_module, "GenerativeModel", None)
    if GenerativeModel is None:
        # A GenerativeModel instance was passed — patch its class.
        GenerativeModel = type(model_or_module)
    _patch_generative_model(GenerativeModel, sdk)


# Back-compat / explicit name used by the auto agent.
def instrument_gemini_module(genai_module: Any, sdk: ScopeCallSDK) -> None:
    GenerativeModel = getattr(genai_module, "GenerativeModel", None)
    if GenerativeModel is not None:
        _patch_generative_model(GenerativeModel, sdk)


def _patch_generative_model(GenerativeModel: Any, sdk: ScopeCallSDK) -> None:
    if getattr(GenerativeModel, _PATCHED, False):
        return

    orig = getattr(GenerativeModel, "generate_content", None)
    if orig is not None:
        def wrapped(self: Any, *args: Any, **kwargs: Any) -> Any:
            if bool(kwargs.get("stream", False)):
                return orig(self, *args, **kwargs)  # streaming: passthrough
            ctx = _context.get_current()
            start = time.monotonic()
            ts = now_ms()
            try:
                resp = orig(self, *args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                _emit(sdk, self, None, args, kwargs, ts, start, ctx,
                      status=_status(exc), error_message=str(exc))
                raise
            _emit(sdk, self, resp, args, kwargs, ts, start, ctx)
            _maybe_audit_gemini(sdk, self, args, kwargs, ctx)
            return resp
        GenerativeModel.generate_content = wrapped

    orig_a = getattr(GenerativeModel, "generate_content_async", None)
    if orig_a is not None and inspect.iscoroutinefunction(orig_a):
        async def wrapped_async(self: Any, *args: Any, **kwargs: Any) -> Any:
            if bool(kwargs.get("stream", False)):
                return await orig_a(self, *args, **kwargs)
            ctx = _context.get_current()
            start = time.monotonic()
            ts = now_ms()
            try:
                resp = await orig_a(self, *args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                _emit(sdk, self, None, args, kwargs, ts, start, ctx,
                      status=_status(exc), error_message=str(exc))
                raise
            _emit(sdk, self, resp, args, kwargs, ts, start, ctx)
            return resp
        GenerativeModel.generate_content_async = wrapped_async

    setattr(GenerativeModel, _PATCHED, True)


def _emit(sdk: ScopeCallSDK, model_obj: Any, response: Any, args: tuple, kwargs: dict,
          timestamp_ms: float, start_mono: float, ctx: Any,
          status: str = "success", error_message: str | None = None) -> None:
    latency_ms = int((time.monotonic() - start_mono) * 1000)
    usage = getattr(response, "usage_metadata", None) if response is not None else None
    in_tok = 0
    out_tok = 0
    if usage is not None:
        in_tok = int(getattr(usage, "prompt_token_count", 0) or 0)
        out_tok = int(getattr(usage, "candidates_token_count", 0) or 0)
        # Gemini 3 "thinking" models (e.g. gemini-3-pro) bill reasoning tokens
        # under thoughts_token_count, separate from candidates — include them
        # as output so cost isn't undercounted (or lost when candidates is 0).
        out_tok += int(getattr(usage, "thoughts_token_count", 0) or 0)
        total = int(getattr(usage, "total_token_count", 0) or 0)
        # Last-resort fallback: some responses only populate total — derive
        # the output portion rather than emit a $0 (unknown-cost) row.
        if out_tok == 0 and total > in_tok:
            out_tok = total - in_tok

    out_text = ""
    if response is not None:
        try:
            out_text = response.text or ""
        except Exception:  # noqa: BLE001 — .text raises if blocked/empty
            out_text = ""

    finish_reason: str | None = None
    try:
        cands = getattr(response, "candidates", None) or []
        if cands:
            finish_reason = _normalize_finish_reason(
                getattr(cands[0], "finish_reason", None)
            )
    except Exception:  # noqa: BLE001
        pass

    event = build_llm_event(
        sdk,
        model=_model_name(model_obj),
        provider=PROVIDER,
        input_tokens=int(in_tok or 0),
        output_tokens=int(out_tok or 0),
        latency_ms=latency_ms,
        timestamp_ms=timestamp_ms,
        status=status,
        input_text=_prompt_text(args, kwargs),
        output_text=out_text,
        finish_reason=finish_reason,
        error_message=error_message,
        ctx_override=ctx,
    )
    emit(sdk, event)


def _model_name(model_obj: Any) -> str:
    name = getattr(model_obj, "model_name", None) or getattr(model_obj, "_model_name", None) or ""
    name = str(name)
    return name[len("models/"):] if name.startswith("models/") else name


def _prompt_text(args: tuple, kwargs: dict) -> str:
    contents = kwargs.get("contents")
    if contents is None and args:
        contents = args[0]
    try:
        if contents is None:
            return ""
        if isinstance(contents, str):
            return contents
        if isinstance(contents, (list, tuple)):
            parts: list[str] = []
            for c in contents:
                if isinstance(c, str):
                    parts.append(c)
                elif isinstance(c, dict):
                    p = c.get("parts", c.get("text", ""))
                    parts.append(str(p))
                else:
                    parts.append(str(c))
            return "\n".join(parts)
        return str(contents)
    except Exception:  # noqa: BLE001
        return ""


def _status(exc: BaseException) -> str:
    name = type(exc).__name__
    msg = str(exc).lower()
    if "429" in msg or "resourceexhausted" in name.lower() or "quota" in msg:
        return "rate_limited"
    if "Timeout" in name or "timeout" in msg or "deadline" in msg:
        return "timeout"
    return "error"


def _maybe_audit_gemini(sdk: ScopeCallSDK, model_obj: Any, args: tuple, kwargs: dict,
                        ctx: Any) -> None:
    """Schedule a best-effort prompt-quality audit reusing THIS model object.

    `call_llm` runs one `generate_content` on the same GenerativeModel under
    emit suppression — the audit manager's suppression check prevents that
    borrowed call (which re-enters the class-patched wrapper) from recursing
    into another audit. Sync path only. Never raises into host code."""
    try:
        prompt_text = _prompt_text(args, kwargs)
        if not prompt_text:
            return
        model = _model_name(model_obj)
        feature = (ctx.feature_name if ctx else None) or sdk._config.default_feature
        prompt_version = (
            (ctx.prompt_version if ctx else None) or sdk._config.default_prompt_version
        )

        def call_llm(audit_prompt: str) -> Any:
            with _context.suppress_llm_emit_scope():
                return model_obj.generate_content(audit_prompt).text

        from .._audit import get_audit_manager

        get_audit_manager(sdk).maybe_audit(
            feature_name=feature,
            prompt_version=prompt_version,
            prompt_text=prompt_text,
            model=model,
            provider=PROVIDER,
            project=sdk._config.project,
            call_llm=call_llm,
        )
    except Exception:  # noqa: BLE001 — never break the host
        pass
