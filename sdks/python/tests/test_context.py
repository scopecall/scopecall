"""TraceContext propagation tests.

The contextvars-based propagation has three critical properties to
verify:
  1. Top-level traces get a fresh trace_id + null parent_span_id.
  2. Nested traces inherit the outer trace_id and chain parent_span_id.
  3. Async / asyncio.create_task() propagation works — this is the P0
     reason we chose contextvars over threadlocals.
"""

from __future__ import annotations

import asyncio

import pytest

from scopecall import _context


class TestRootTrace:
    def test_root_trace_has_no_parent(self, make_sdk):
        sdk = make_sdk()
        with sdk.trace("root") as ctx:
            assert ctx.parent_span_id is None
            assert ctx.trace_id  # non-empty
            assert ctx.span_id  # non-empty
            assert ctx.name == "root"

    def test_two_sibling_traces_have_distinct_trace_ids(self, make_sdk):
        sdk = make_sdk()
        with sdk.trace("a") as a:
            pass
        with sdk.trace("b") as b:
            pass
        assert a.trace_id != b.trace_id


class TestNestedTrace:
    def test_inner_inherits_trace_id(self, make_sdk):
        sdk = make_sdk()
        with sdk.trace("outer") as outer:
            with sdk.trace("inner") as inner:
                assert inner.trace_id == outer.trace_id

    def test_inner_chains_parent_span_id(self, make_sdk):
        sdk = make_sdk()
        with sdk.trace("outer") as outer:
            with sdk.trace("inner") as inner:
                assert inner.parent_span_id == outer.span_id

    def test_inner_has_distinct_span_id(self, make_sdk):
        sdk = make_sdk()
        with sdk.trace("outer") as outer:
            with sdk.trace("inner") as inner:
                assert inner.span_id != outer.span_id

    def test_context_unwinds_on_exit(self, make_sdk):
        sdk = make_sdk()
        with sdk.trace("outer") as outer:
            with sdk.trace("inner"):
                pass
            # After inner exits, the outer's context is back as current.
            assert _context.get_current() is outer
        # After outer exits, there's no current context.
        assert _context.get_current() is None

    def test_context_unwinds_on_exception(self, make_sdk):
        sdk = make_sdk()
        # The trace block must NOT swallow exceptions, but it MUST still
        # restore the previous context — the workflow-event emission is
        # also expected to fire on the exceptional path. Verified by
        # confirming current is None after the outer exits.
        with pytest.raises(RuntimeError):
            with sdk.trace("outer"):
                with sdk.trace("inner"):
                    raise RuntimeError("boom")
        assert _context.get_current() is None


class TestPromptVersionPrecedence:
    """trace() opts → parent trace → config default → None.

    Matches the TS SDK contract documented in
    sdks/typescript/src/index.ts buildWorkflowEvent.
    """

    def test_trace_kwarg_wins_over_parent(self, make_sdk):
        sdk = make_sdk()
        with sdk.trace("outer", prompt_version="v1"):
            with sdk.trace("inner", prompt_version="v2") as inner:
                assert inner.prompt_version == "v2"

    def test_inner_inherits_parent_when_kwarg_omitted(self, make_sdk):
        sdk = make_sdk()
        with sdk.trace("outer", prompt_version="v1"):
            with sdk.trace("inner") as inner:
                assert inner.prompt_version == "v1"

    def test_inner_falls_back_to_config_default(self, make_sdk):
        sdk = make_sdk(default_prompt_version="cfg")
        with sdk.trace("outer") as ctx:
            assert ctx.prompt_version == "cfg"

    def test_trace_kwarg_wins_over_config_default(self, make_sdk):
        sdk = make_sdk(default_prompt_version="cfg")
        with sdk.trace("outer", prompt_version="explicit") as ctx:
            assert ctx.prompt_version == "explicit"


class TestAsyncPropagation:
    """contextvars must propagate across await — this is the P0 reason
    we chose contextvars over threadlocals."""

    async def test_trace_propagates_across_await(self, make_sdk):
        sdk = make_sdk()

        async def inner_work():
            # The current trace must be visible here, in a coroutine
            # that was created inside the trace block but is awaited
            # asynchronously.
            ctx = _context.get_current()
            assert ctx is not None
            return ctx.trace_id

        async def outer():
            with sdk.trace("outer") as outer_ctx:
                child_trace_id = await inner_work()
                return outer_ctx.trace_id, child_trace_id

        outer_id, inner_id = await outer()
        assert outer_id == inner_id

    async def test_create_task_inherits_context(self, make_sdk):
        sdk = make_sdk()
        observed: dict[str, str | None] = {}

        async def task_body():
            ctx = _context.get_current()
            observed["trace_id"] = ctx.trace_id if ctx else None

        with sdk.trace("with-task") as ctx:
            await asyncio.create_task(task_body())

        assert observed["trace_id"] == ctx.trace_id
