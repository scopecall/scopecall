"""Workflow-span emission tests.

Verifies the Round-3 P0 contract from the TS SDK: every `sdk.trace()`
block emits a synthetic `kind='workflow'` LLMEvent when the block exits.
Without this, child LLM rows would have a `parent_span_id` pointing at
nothing and the dashboard's flow-map JOIN finds no parent.

Uses file mode so we can read back exactly what was emitted without
needing a running ingest service.
"""

from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

import scopecall


def _read_events(path: str) -> list[dict]:
    """Read NDJSON events from the file the SDK emitted to.

    Sleeps briefly to let the background flush thread tick. The SDK
    can also be `.flush()`ed deterministically — we do both because
    the flush window depends on the SDK lifecycle, and individual tests
    might close before manually calling flush.
    """
    time.sleep(0.5)  # give the flush thread one tick
    p = Path(path)
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


class TestWorkflowEmission:
    def test_trace_block_emits_workflow_event(self):
        # File mode is the cleanest test transport — we can read back
        # exactly what was emitted without faking the HTTP layer.
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name
        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            with sdk.trace("test-workflow"):
                pass
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["kind"] == "workflow"
        assert ev["feature_name"] == "test-workflow"
        # Workflow spans MUST have empty model/provider so they're
        # filtered out of LLM analytics rollups. (Round-4 P0.)
        assert ev["model"] == ""
        assert ev["provider"] == ""
        # And zero tokens / zero cost — they're synthetic markers, not
        # actual LLM calls.
        assert ev["input_tokens"] == 0
        assert ev["output_tokens"] == 0
        assert ev["cost_usd"] == 0.0
        # None vs "" matters; workflow spans have no payload.
        assert ev["input_text"] is None
        assert ev["output_text"] is None

    def test_nested_traces_chain_parent_span_id(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name
        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            outer_span_id = None
            inner_span_id = None
            with sdk.trace("outer") as outer:
                outer_span_id = outer.span_id
                with sdk.trace("inner") as inner:
                    inner_span_id = inner.span_id
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        # File order: inner block exits first → inner workflow event
        # emitted first; outer exits second.
        assert len(events) == 2
        inner_ev = next(e for e in events if e["span_id"] == inner_span_id)
        outer_ev = next(e for e in events if e["span_id"] == outer_span_id)
        assert inner_ev["parent_span_id"] == outer_span_id
        assert outer_ev["parent_span_id"] is None
        # Trace ID shared between outer and inner.
        assert inner_ev["trace_id"] == outer_ev["trace_id"]

    def test_exception_in_block_emits_error_workflow(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name
        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            try:
                with sdk.trace("will-fail"):
                    raise RuntimeError("simulated")
            except RuntimeError:
                pass
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["kind"] == "workflow"
        assert ev["status"] == "error"
        assert ev["error_message"] == "simulated"

    def test_workflow_event_carries_prompt_version(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name
        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            with sdk.trace("tagged", prompt_version="v3"):
                pass
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        assert events[0]["prompt_version"] == "v3"


class TestRecordLlmCall:
    def test_record_outside_trace_emits_orphan_llm_event(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name
        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            sdk.record_llm_call(
                model="gpt-4o-mini",
                provider="openai",
                input_tokens=10,
                output_tokens=20,
                latency_ms=100,
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        assert ev["kind"] == "llm"
        assert ev["model"] == "gpt-4o-mini"
        assert ev["parent_span_id"] is None  # orphan, no enclosing trace

    def test_record_inside_trace_attaches_parent_span(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name
        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            with sdk.trace("ctx") as ctx:
                sdk.record_llm_call(
                    model="gpt-4o-mini",
                    provider="openai",
                    input_tokens=10,
                    output_tokens=20,
                    latency_ms=100,
                )
                ctx_span_id = ctx.span_id
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        # Two events: the LLM call + the workflow span (emitted on exit).
        assert len(events) == 2
        llm_ev = next(e for e in events if e["kind"] == "llm")
        wf_ev = next(e for e in events if e["kind"] == "workflow")
        assert llm_ev["parent_span_id"] == ctx_span_id
        assert wf_ev["span_id"] == ctx_span_id
        assert llm_ev["trace_id"] == wf_ev["trace_id"]

    def test_record_respects_capture_content_false(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name
        sdk = scopecall.init(
            output=path, flush_interval=0.1, capture_content=False
        )
        try:
            sdk.record_llm_call(
                model="gpt-4o-mini",
                provider="openai",
                input_tokens=10,
                output_tokens=20,
                latency_ms=100,
                input_text="don't capture me",
                output_text="me neither",
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        assert events[0]["input_text"] is None
        assert events[0]["output_text"] is None
