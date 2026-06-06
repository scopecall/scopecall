"""ScopeCallSDK — the instance returned by `init()`.

Surface matches the TS SDK's `ScopeCallSDK` interface (sdks/typescript/src/index.ts).
Public API on the instance:

  sdk.trace(name, ...)         # context manager, emits a workflow span on exit
  # sdk.span(name) is experimental — use nested sdk.trace() instead
  sdk.record_llm_call(...)     # manual escape hatch for LangChain / LlamaIndex
  sdk.flush(timeout=5.0)       # block until queue drains
  sdk.close(timeout=5.0)       # shutdown + final flush

The reviewer asked for the `sdk = init(...)` shape rather than the
module-level globals the v0.1 Python SDK used. This matches because:

  - Multiple SDKs in one process (rare, but legitimate — e.g. a meta-tool
    that observes another ScopeCall instance) need separate state.
  - Tests can spin up and tear down isolated instances without
    mutating module-level state.
  - The TS shape `sdk = init(...); await sdk.trace(...)` is the same
    cross-language ergonomics we want.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Generator
from contextlib import contextmanager
from typing import TYPE_CHECKING

from . import _context
from ._config import ScopeCallConfig, validate
from ._exporter import Exporter
from ._redactor import Redactor
from ._version import __version__
from .instrumentation._common import apply_redaction
from .wire._event import LLMEvent

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class ScopeCallSDK:
    """The SDK instance.

    Treat this as a long-lived singleton in your application. Auto-flush
    fires every `config.flush_interval` seconds in a background thread;
    `close()` is the graceful shutdown.
    """

    def __init__(self, config: ScopeCallConfig) -> None:
        self._config = config
        self._exporter = Exporter(config)
        # Single redactor instance shared across every event the SDK
        # emits. The TS SDK does the same — `redact: true` once on init
        # rather than reconstructing the regex set per event. Custom
        # patterns added via `sdk.add_pattern()` extend this instance.
        self._redactor: Redactor | None = Redactor() if config.redact_pii else None
        self._closed = False

    # ── Public properties ──────────────────────────────────────────────

    @property
    def config(self) -> ScopeCallConfig:
        return self._config

    @property
    def disabled(self) -> bool:
        """Match the TS SDK's `disabled` property — true when init was
        called with `disabled=True` and the SDK is a no-op."""
        return self._config.disabled

    # ── trace() ─────────────────────────────────────────────────────────

    @contextmanager
    def trace(
        self,
        name: str,
        *,
        feature_name: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        customer_id: str | None = None,
        prompt_version: str | None = None,
        kind: str = "workflow",
    ) -> Generator[_context.TraceContext, None, None]:
        """Run a block as a named workflow trace.

        Emits a synthetic workflow event (kind='workflow') when the block
        exits. LLM calls inside the block will reference this block's
        `span_id` as their `parent_span_id` — that's how the trace tree
        and Flow Map render the parent → child structure.

        Usage:

            with sdk.trace("support-agent", user_id="u_123") as ctx:
                response = openai_client.chat.completions.create(...)

        Nesting works correctly. The inner `sdk.trace()` inherits the
        outer's `trace_id`, gets its own `span_id`, and sets
        `parent_span_id = outer.span_id`. `prompt_version` inherits from
        the parent unless explicitly overridden in the child call.
        """
        parent = _context.get_current()

        # Resolve prompt_version precedence: explicit kwarg > parent
        # trace > config default > None. Matches the TS contract.
        resolved_prompt_version = prompt_version
        if resolved_prompt_version is None and parent is not None:
            resolved_prompt_version = parent.prompt_version
        if resolved_prompt_version is None:
            resolved_prompt_version = self._config.default_prompt_version

        # customer_id precedence: explicit kwarg > parent trace > None.
        # B2B apps typically set it on the outermost trace (request entry)
        # and let it propagate down — matches user_id / session_id behavior.
        resolved_customer_id = customer_id
        if resolved_customer_id is None and parent is not None:
            resolved_customer_id = parent.customer_id

        ctx = _context.TraceContext(
            trace_id=parent.trace_id if parent else _context.new_trace_id(),
            span_id=_context.new_span_id(),
            parent_span_id=parent.span_id if parent else None,
            name=name,
            prompt_version=resolved_prompt_version,
            user_id=user_id,
            session_id=session_id,
            customer_id=resolved_customer_id,
            feature_name=feature_name or name,
            start_time_ms=time.time() * 1000.0,
            kind=kind,
        )
        token = _context.push(ctx)

        # We instrument the block as a try/except/finally so the workflow
        # event reflects whether the block succeeded. The TS SDK does the
        # same — see sdks/typescript/src/index.ts buildWorkflowEvent.
        status: str = "success"
        error_message: str | None = None
        try:
            yield ctx
        except Exception as exc:
            status = "error"
            error_message = str(exc)
            # Re-raise — we never swallow customer exceptions. The event
            # still gets emitted in the `finally` below.
            raise
        finally:
            _context.pop(token)
            end_ms = time.time() * 1000.0
            latency_ms = max(0, int(end_ms - ctx.start_time_ms))
            self._emit_workflow_event(ctx, latency_ms, status, error_message)

    def _emit_workflow_event(
        self,
        ctx: _context.TraceContext,
        latency_ms: int,
        status: str,
        error_message: str | None,
    ) -> None:
        """Construct + enqueue the synthetic workflow event.

        kind='workflow', zero tokens, zero cost, empty model/provider —
        these rows live in `llm_calls` but are filtered out of the
        kind-aware analytics rollup. The dashboard's trace tree and
        Flow Map JOIN on these rows to find each trace's true parent.
        """
        event = LLMEvent(
            trace_id=ctx.trace_id,
            span_id=ctx.span_id,
            parent_span_id=ctx.parent_span_id,
            timestamp=ctx.start_time_ms,
            latency_ms=latency_ms,
            ttft_ms=None,
            model="",
            provider="",
            input_tokens=0,
            output_tokens=0,
            cost_usd=0.0,
            status=status,
            error_message=error_message,
            # input_text/output_text intentionally None — workflow rows
            # have no payload of their own; children carry the prompts.
            input_text=None,
            output_text=None,
            feature_name=ctx.feature_name or self._config.default_feature,
            user_id=ctx.user_id or self._config.default_user_id,
            session_id=ctx.session_id or self._config.default_session_id,
            customer_id=ctx.customer_id,
            environment=self._config.environment,
            is_test=bool(self._config.test),
            sdk_version=__version__,
            prompt_version=ctx.prompt_version,
            kind=ctx.kind,
        )
        self._exporter.enqueue(event)

    # ── workflow() / agent() / step() — cost-attribution hierarchy ────
    #
    # Thin aliases over trace() that read more naturally in instrumented
    # code. The three levels (workflow → agent → step) match how AI apps
    # are actually built:
    #
    #     with sdk.workflow("support_refund"):
    #         with sdk.agent("policy_check"):
    #             with sdk.step("retrieve_policy"):
    #                 docs = vector_db.query(...)
    #             with sdk.step("draft_response"):
    #                 response = openai_client.chat.completions.create(...)
    #
    # The dashboard groups cost / latency / error rates at each level so
    # you can see "Refund workflow cost $5,900; 68% is in the policy
    # agent's draft_response step." That's the cost-attribution story
    # ScopeCall's v0.3 release builds the dashboard around.
    #
    # Why these are "aliases" and not enforced hierarchy: customers won't
    # refactor their code to fit our taxonomy. Nesting is voluntary —
    # `sdk.agent()` works as a top-level block if there's no surrounding
    # workflow, and `sdk.step()` works on its own. The dashboard groups
    # by name + kind regardless of nesting depth.
    #
    # Wire-format note: each method emits its own kind value
    # (workflow / agent / step). The Rust ingest validates the closed
    # set {"llm", "workflow", "agent", "step"} and the processor zeroes
    # cost/tokens for all three container kinds — see
    # services-rust/processor/src/enricher.rs reprice().

    @contextmanager
    def workflow(
        self,
        name: str,
        *,
        feature_name: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        customer_id: str | None = None,
        prompt_version: str | None = None,
    ) -> Generator[_context.TraceContext, None, None]:
        """Mark a block as a workflow — the top of the cost-attribution
        hierarchy. Equivalent to sdk.trace() but reads more naturally
        inside instrumented agent/RAG/multi-step code.

        Usage:

            with sdk.workflow("support_refund"):
                ...
        """
        with self.trace(
            name,
            feature_name=feature_name,
            user_id=user_id,
            session_id=session_id,
            customer_id=customer_id,
            prompt_version=prompt_version,
            kind="workflow",
        ) as ctx:
            yield ctx

    @contextmanager
    def agent(
        self,
        name: str,
        *,
        feature_name: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        customer_id: str | None = None,
        prompt_version: str | None = None,
    ) -> Generator[_context.TraceContext, None, None]:
        """Mark a block as an agent. Typically nested inside a workflow
        but works standalone too.

        Usage:

            with sdk.agent("policy_check"):
                ...
        """
        with self.trace(
            name,
            feature_name=feature_name,
            user_id=user_id,
            session_id=session_id,
            customer_id=customer_id,
            prompt_version=prompt_version,
            kind="agent",
        ) as ctx:
            yield ctx

    @contextmanager
    def step(
        self,
        name: str,
        *,
        feature_name: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        customer_id: str | None = None,
        prompt_version: str | None = None,
    ) -> Generator[_context.TraceContext, None, None]:
        """Mark a block as a step within an agent. The most granular
        level of the workflow/agent/step hierarchy.

        Usage:

            with sdk.step("retrieve_policy"):
                ...
        """
        with self.trace(
            name,
            feature_name=feature_name,
            user_id=user_id,
            session_id=session_id,
            customer_id=customer_id,
            prompt_version=prompt_version,
            kind="step",
        ) as ctx:
            yield ctx

    # ── span() — experimental / internal, do NOT use ──────────────────
    #
    # ⚠️  EXPERIMENTAL. Excluded from the public API surface.
    #
    # `span()` chains the parent_span_id contextvar without emitting a
    # row. The Round-12 reviewer correctly flagged that this creates
    # virtual parents: any child LLM call that references the span's
    # span_id as parent_span_id has no persisted row to JOIN to in
    # ClickHouse, breaking the dashboard's trace tree + flow map
    # hierarchy.
    #
    # Public guidance (in README + __init__.py) is to nest
    # `sdk.trace(name)` blocks instead — each nested trace emits a
    # real workflow row and the parent chain works end-to-end.
    #
    # Why keep this in source at all (vs delete in v0.2.0): there may
    # already be early-access callers who imported it before the
    # publish. Removing it would be a hard break. We'll fully remove
    # in v0.3.0 once we can confirm no external usage; until then
    # this method exists, isn't documented, and emits a runtime
    # warning on first call.

    _span_warned: bool = False

    @contextmanager
    def span(
        self,
        name: str,
        *,
        kind: str | None = None,
    ) -> Generator[_context.TraceContext, None, None]:
        """⚠️  EXPERIMENTAL — do not use in new code.

        Opens a nested span that chains `parent_span_id` but does NOT
        emit a workflow row. That makes children of this span orphan
        in the dashboard's trace tree (their `parent_span_id` points
        at nothing in ClickHouse). Use `sdk.trace(name)` instead —
        every nested `trace()` emits a real workflow row and the
        parent chain stays intact.

        Scheduled for removal in v0.3.0.
        """
        if not type(self)._span_warned:
            type(self)._span_warned = True
            import warnings

            warnings.warn(
                "sdk.span() is experimental and creates orphan child "
                "events in the dashboard's trace tree — children "
                "reference a span_id that has no persisted row. Use "
                "nested sdk.trace(name) blocks instead. "
                "sdk.span() will be removed in v0.3.0.",
                DeprecationWarning,
                stacklevel=2,
            )
        del kind
        parent = _context.get_current()
        ctx = _context.TraceContext(
            trace_id=parent.trace_id if parent else _context.new_trace_id(),
            span_id=_context.new_span_id(),
            parent_span_id=parent.span_id if parent else None,
            name=name,
            prompt_version=parent.prompt_version if parent else None,
            user_id=parent.user_id if parent else None,
            session_id=parent.session_id if parent else None,
            feature_name=parent.feature_name if parent else name,
            start_time_ms=time.time() * 1000.0,
        )
        token = _context.push(ctx)
        try:
            yield ctx
        finally:
            _context.pop(token)

    # ── instrument() — auto-trace OpenAI / Anthropic client calls ──────

    def instrument(
        self,
        client: object,
        provider: str = "openai",
    ) -> object:
        """Wrap a provider client so its LLM calls are auto-traced.

        Mirrors the TS SDK's `sdk.instrument(client, "openai" | "anthropic")`
        API. The client is mutated in place — its `chat.completions.create`
        (OpenAI) or `messages.create` (Anthropic) method is replaced with
        a wrapper that:

          1. Resolves the current TraceContext (so the event hangs off
             the enclosing sdk.trace() block as a child).
          2. Calls the underlying method.
          3. Captures latency, tokens, output text, finish_reason, TTFT
             (for streams).
          4. Enqueues an LLMEvent with kind='llm'.
          5. Returns the original response unchanged (or a wrapped
             iterator/async iterator for streams).

        Sync vs async is auto-detected from the client class — pass an
        `OpenAI()` and you get sync wrapping; pass an `AsyncOpenAI()`
        and you get async wrapping. Same for Anthropic.

        Returns the same client instance for chaining convenience.

        Usage:

            from openai import OpenAI
            client = sdk.instrument(OpenAI())            # sync OpenAI
            client.chat.completions.create(...)          # auto-traced

            from anthropic import AsyncAnthropic
            client = sdk.instrument(AsyncAnthropic(), provider="anthropic")
            await client.messages.create(...)            # auto-traced

        If the SDK is disabled (init(disabled=True)), this is a no-op.
        """
        if self._config.disabled:
            return client

        # Lazy imports — the user might not have anthropic installed,
        # and importing it eagerly would fail. Each instrumentation
        # module raises a clearer error if its provider package is
        # missing.
        if provider == "openai":
            from .instrumentation._openai import instrument_openai

            instrument_openai(client, self)
        elif provider == "anthropic":
            from .instrumentation._anthropic import instrument_anthropic

            instrument_anthropic(client, self)
        else:
            raise ValueError(
                f"unknown provider: {provider!r}. "
                "Supported: 'openai', 'anthropic'."
            )
        return client

    # ── record_llm_call() — escape hatch for manual instrumentation ────

    def record_llm_call(
        self,
        *,
        model: str,
        provider: str,
        input_tokens: int,
        output_tokens: int,
        latency_ms: int,
        status: str = "success",
        cost_usd: float = 0.0,
        ttft_ms: int | None = None,
        input_text: str | None = None,
        output_text: str | None = None,
        feature_name: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        customer_id: str | None = None,
        prompt_version: str | None = None,
        finish_reason: str | None = None,
        cache_read_tokens: int | None = None,
        error_message: str | None = None,
        extra: str | None = None,
        tool_calls: str | None = None,
        attempt_number: int = 1,
        retry_reason: str | None = None,
    ) -> None:
        """Manually record an LLM call as if a provider instrumentation had.

        The escape hatch the reviewer correctly called out as a P0 for
        the Python ecosystem. LangChain / LlamaIndex / CrewAI / RAG
        pipelines / internal LLM wrappers all need to be observable
        before we ship per-framework integrations.

        The caller is responsible for measuring latency_ms and supplying
        token counts. parent_span_id is auto-resolved from the current
        TraceContext if the call is inside a `sdk.trace()` block;
        otherwise the event is treated as a top-level orphan trace.

        cost_usd is advisory — the Rust processor recomputes it from the
        bundled pricing table before storage. Pass 0.0 if you don't know.
        """
        ctx = _context.get_current()
        trace_id = ctx.trace_id if ctx else _context.new_trace_id()
        parent_span_id = ctx.span_id if ctx else None

        resolved_feature = (
            feature_name
            or (ctx.feature_name if ctx else None)
            or self._config.default_feature
        )
        resolved_user = (
            user_id or (ctx.user_id if ctx else None) or self._config.default_user_id
        )
        resolved_session = (
            session_id
            or (ctx.session_id if ctx else None)
            or self._config.default_session_id
        )
        resolved_customer = (
            customer_id
            or (ctx.customer_id if ctx else None)
        )
        resolved_prompt_version = (
            prompt_version
            or (ctx.prompt_version if ctx else None)
            or self._config.default_prompt_version
        )

        # Apply the redactor + capture_content policy via the same
        # helper the provider instrumentations use. Round-12 review P0a:
        # this used to construct LLMEvent directly with the raw
        # input_text / output_text the caller supplied, bypassing the
        # redactor — which falsified the "redact_pii=True scrubs
        # input/output before leaving the process" claim for manual
        # instrumentation (LangChain / LlamaIndex / custom).
        input_text, output_text = apply_redaction(self, input_text, output_text)

        # We do NOT convert None → "" here — the Round-2 review fixed
        # the wire contract so None means "SDK didn't capture" and ""
        # means "empty payload"; the distinction matters in CH.
        event = LLMEvent(
            trace_id=trace_id,
            span_id=_context.new_span_id(),
            parent_span_id=parent_span_id,
            timestamp=time.time() * 1000.0 - latency_ms,
            latency_ms=latency_ms,
            ttft_ms=ttft_ms,
            model=model,
            provider=provider,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            status=status,
            error_message=error_message,
            input_text=input_text,
            output_text=output_text,
            feature_name=resolved_feature,
            user_id=resolved_user,
            session_id=resolved_session,
            customer_id=resolved_customer,
            environment=self._config.environment,
            is_test=bool(self._config.test),
            sdk_version=__version__,
            extra=extra,
            attempt_number=attempt_number,
            retry_reason=retry_reason,
            finish_reason=finish_reason,
            cache_read_tokens=cache_read_tokens,
            tool_calls=tool_calls,
            prompt_version=resolved_prompt_version,
            kind="llm",
        )
        self._exporter.enqueue(event)

    # ── add_redaction_pattern() — extend the default PII redactor ──────

    def add_redaction_pattern(
        self,
        name: str,
        regex: str,
        replacement: str | None = None,
    ) -> None:
        """Add a custom PII redaction pattern.

        Patterns are appended to the SDK's existing redactor (EMAIL,
        CARD, SSN, IP, PHONE by default). `regex` is a standard Python
        regex; `replacement` defaults to `[NAME]` if omitted.

        No-op when the SDK was initialized with `redact_pii=False` or
        in disabled mode.

        Example:

            sdk.add_redaction_pattern(
                "UUID",
                r"\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
                r"[0-9a-f]{4}-[0-9a-f]{12}\\b",
            )

        Round-12 review polish: the README used to suggest
        `sdk._redactor.add_pattern(...)` which is a private API.
        Promoting this to a public method gives operators a stable
        surface to extend redaction on.
        """
        if self._redactor is None:
            return
        self._redactor.add_pattern(name, regex, replacement)

    # ── Lifecycle ──────────────────────────────────────────────────────

    def flush(self, timeout: float = 5.0) -> None:
        """Block until queued events have been shipped (or `timeout`)."""
        self._exporter.flush(timeout=timeout)

    def close(self, timeout: float = 5.0) -> None:
        """Final flush + tear down the background thread. Idempotent."""
        if self._closed:
            return
        self._closed = True
        self._exporter.close(timeout=timeout)


def init(config: ScopeCallConfig | None = None, **kwargs: object) -> ScopeCallSDK:
    """Initialize the SDK. Returns a `ScopeCallSDK` instance.

    Two equivalent invocation styles — pick whichever your codebase
    prefers:

        # Style 1: kwargs (the reviewer's example, idiomatic Python)
        sdk = scopecall.init(
            api_key="sc_live_xxx",
            endpoint="http://localhost:8080/v1/ingest",
            environment="production",
        )

        # Style 2: prebuilt config (useful for dependency injection /
        #          shared config objects)
        cfg = ScopeCallConfig(api_key="sc_live_xxx", endpoint="...")
        sdk = scopecall.init(cfg)

    The previous module-level-globals API (`scopecall.init(); scopecall.trace(...)`)
    is gone. If you imported the v0.1 SDK that way, see the migration
    note in CHANGELOG.md.
    """
    if config is not None and kwargs:
        raise TypeError(
            "init() got both a config object and kwargs. Pass one or the other."
        )
    if config is None:
        # Build a config from kwargs. Use **kwargs spread; ScopeCallConfig
        # is a @dataclass so unknown keys raise TypeError, which is
        # exactly the developer experience we want — typos surface
        # immediately instead of being silently ignored.
        config = ScopeCallConfig(**kwargs)  # type: ignore[arg-type]
    validate(config)
    return ScopeCallSDK(config)
