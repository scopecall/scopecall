"""PII redaction parity tests across manual + auto-instrumented paths.

The manual API (`record_llm_call`) used to construct LLMEvent directly
without running the redactor — falsifying
the "redact_pii=True scrubs input/output before leaving the process"
promise for LangChain / LlamaIndex / custom-wrapper callers.

These tests pin the contract: both code paths (auto-instrumented
provider call AND manual record_llm_call) MUST produce events whose
input_text / output_text have been through the redactor when
redact_pii=True.

Also covers the public `sdk.add_redaction_pattern(...)` API the README
now points at (replacing the previous `sdk._redactor.add_pattern(...)`
private-attribute pattern).
"""

from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import scopecall


def _read_events(path: str) -> list[dict[str, Any]]:
    time.sleep(0.5)
    p = Path(path)
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]


# Each test gets its own tmp file → fresh SDK → close on the way out.
# We could fixture this but the pattern is short enough inline.


class TestRecordLlmCallRedaction:
    """Manual API must redact PII when redact_pii=True."""

    def test_record_llm_call_redacts_pii_by_default(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        # Default: redact_pii=True
        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            sdk.record_llm_call(
                model="gpt-4o-mini",
                provider="openai",
                input_tokens=1,
                output_tokens=1,
                latency_ms=1,
                input_text="email a@b.com card 4242 4242 4242 4242",
                output_text="reply: phone 415-555-1212 ssn 123-45-6789",
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert len(events) == 1
        ev = events[0]
        # These MUST be replaced or the redaction promise is false:
        assert "[EMAIL]" in ev["input_text"]
        assert "[CARD]" in ev["input_text"]
        assert "[PHONE]" in ev["output_text"]
        assert "[SSN]" in ev["output_text"]
        # Sanity: original PII must NOT survive.
        assert "a@b.com" not in ev["input_text"]
        assert "4242 4242" not in ev["input_text"]
        assert "415-555" not in ev["output_text"]
        assert "123-45" not in ev["output_text"]

    def test_record_llm_call_honors_redact_pii_false(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        sdk = scopecall.init(output=path, flush_interval=0.1, redact_pii=False)
        try:
            sdk.record_llm_call(
                model="gpt-4o-mini",
                provider="openai",
                input_tokens=1,
                output_tokens=1,
                latency_ms=1,
                input_text="contact a@b.com",
                output_text="ok",
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        # redact_pii=False means raw content is shipped as-is — the user
        # opted out, document expects the raw email.
        assert events[0]["input_text"] == "contact a@b.com"

    def test_record_llm_call_honors_capture_content_false(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        sdk = scopecall.init(output=path, flush_interval=0.1, capture_content=False)
        try:
            sdk.record_llm_call(
                model="gpt-4o-mini",
                provider="openai",
                input_tokens=1,
                output_tokens=1,
                latency_ms=1,
                input_text="don't capture me",
                output_text="me neither",
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        # capture_content=False overrides — None on wire, not "".
        events = _read_events(path)
        assert events[0]["input_text"] is None
        assert events[0]["output_text"] is None


class TestParityWithAutoInstrumentation:
    """Auto-instrumented and manual paths must apply the same policy.

    If we changed the redactor in one place but forgot the other, this
    test catches it.
    """

    def test_auto_instrument_also_redacts(self):
        """The auto-instrumented OpenAI path uses the same apply_redaction
        helper, so PII must scrub here too."""
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        def fake_create(**kwargs):
            return SimpleNamespace(
                model="gpt-4o-mini",
                usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1),
                choices=[SimpleNamespace(
                    message=SimpleNamespace(
                        content="reply: contact b@c.com",
                        tool_calls=None,
                    ),
                    finish_reason="stop",
                )],
            )

        fake_client = SimpleNamespace(
            chat=SimpleNamespace(
                completions=SimpleNamespace(create=fake_create),
            ),
        )

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            sdk.instrument(fake_client, provider="openai")
            fake_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": "email me at a@b.com"}],
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert "[EMAIL]" in events[0]["input_text"]
        assert "[EMAIL]" in events[0]["output_text"]


class TestAddRedactionPattern:
    """Public method on the SDK — the README points at this rather
    than the private `sdk._redactor.add_pattern`."""

    def test_custom_pattern_is_applied(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            path = f.name

        sdk = scopecall.init(output=path, flush_interval=0.1)
        try:
            sdk.add_redaction_pattern("UUID", r"\bxx-\d{4}-yy\b")
            sdk.record_llm_call(
                model="gpt-4o-mini",
                provider="openai",
                input_tokens=1,
                output_tokens=1,
                latency_ms=1,
                input_text="token is xx-1234-yy here",
                output_text="ok",
            )
            sdk.flush(timeout=2.0)
        finally:
            sdk.close(timeout=2.0)

        events = _read_events(path)
        assert "[UUID]" in events[0]["input_text"]
        assert "xx-1234-yy" not in events[0]["input_text"]

    def test_no_redactor_when_redact_pii_false_is_noop(self):
        # add_redaction_pattern should not crash when there's no
        # underlying redactor — return silently.
        sdk = scopecall.init(debug=True, redact_pii=False)
        try:
            sdk.add_redaction_pattern("X", r"foo")  # should not raise
        finally:
            sdk.close(timeout=2.0)
