"""LLMEvent wire-format parity tests.

Two contracts being verified:
  1. Every wire field exists with the right default. Adding a field here
     without mirroring it in the TS SDK and Rust ingest is a wire break.
  2. to_wire() round-trips deterministically to JSON.
"""

from __future__ import annotations

import json

from scopecall.wire._event import LLMEvent


class TestLLMEventFields:
    """Field-by-field parity with the wire shape."""

    def _minimal(self) -> LLMEvent:
        # Minimal valid event — all required positional fields set.
        return LLMEvent(
            trace_id="t1",
            span_id="s1",
            parent_span_id=None,
            timestamp=1.0,
            latency_ms=10,
            ttft_ms=None,
            model="gpt-4o",
            provider="openai",
            input_tokens=1,
            output_tokens=2,
            cost_usd=0.01,
        )

    def test_defaults_for_round_2_content_fields(self):
        # input_text / output_text are Optional[str] with None as the
        # default. "" and None are distinct on the wire.
        ev = self._minimal()
        assert ev.input_text is None
        assert ev.output_text is None

    def test_default_status_is_success(self):
        assert self._minimal().status == "success"

    def test_default_kind_is_llm(self):
        # kind defaults to 'llm'; container spans (workflow / agent / step)
        # set it explicitly. The Rust ingest validates the field against
        # the closed set {llm, workflow, agent, step} so a wrong default
        # would silently mis-classify every event.
        assert self._minimal().kind == "llm"

    def test_round_3_cost_split_defaults_none(self):
        ev = self._minimal()
        assert ev.input_cost_usd is None
        assert ev.output_cost_usd is None

    def test_round_3_routing_fields_default_none(self):
        ev = self._minimal()
        assert ev.original_model is None
        assert ev.budget_state is None
        assert ev.failure_mode is None
        assert ev.tool_calls is None

    def test_round_4_prompt_version_defaults_none(self):
        assert self._minimal().prompt_version is None

    def test_round_1_p1_streaming_fields_default_none(self):
        ev = self._minimal()
        assert ev.finish_reason is None
        assert ev.cache_read_tokens is None


class TestToWire:
    """The HTTP envelope to the Rust ingest is a JSON dict per event."""

    def test_to_wire_is_json_serializable(self):
        ev = LLMEvent(
            trace_id="t1",
            span_id="s1",
            parent_span_id=None,
            timestamp=1.0,
            latency_ms=10,
            ttft_ms=None,
            model="gpt-4o",
            provider="openai",
            input_tokens=1,
            output_tokens=2,
            cost_usd=0.01,
            input_text="hello",
            output_text="world",
            prompt_version="v1",
            kind="llm",
        )
        wire = ev.to_wire()
        # Must serialize cleanly — no datetime / non-primitive sneaks in.
        s = json.dumps(wire)
        # Decode + check a couple of representative fields survive.
        back = json.loads(s)
        assert back["trace_id"] == "t1"
        assert back["kind"] == "llm"
        assert back["prompt_version"] == "v1"
        assert back["input_text"] == "hello"

    def test_to_wire_preserves_none_for_unset_text(self):
        # None vs "" matters — the Rust ingest stores them distinctly,
        # and the SDK preserves that distinction.
        ev = LLMEvent(
            trace_id="t1",
            span_id="s1",
            parent_span_id=None,
            timestamp=1.0,
            latency_ms=10,
            ttft_ms=None,
            model="",
            provider="",
            input_tokens=0,
            output_tokens=0,
            cost_usd=0.0,
            kind="workflow",
        )
        wire = ev.to_wire()
        assert wire["input_text"] is None
        assert wire["output_text"] is None

    def test_to_wire_carries_workflow_kind(self):
        ev = LLMEvent(
            trace_id="t1",
            span_id="s1",
            parent_span_id="p1",
            timestamp=1.0,
            latency_ms=200,
            ttft_ms=None,
            model="",
            provider="",
            input_tokens=0,
            output_tokens=0,
            cost_usd=0.0,
            kind="workflow",
        )
        assert ev.to_wire()["kind"] == "workflow"
