"""Fork safety — events recorded in multiprocessing children must survive.

Reproduces the trending-dashboard outage (2026-07-14): the app ran its LLM
stage inside a forked multiprocessing.Process. The child inherited the
exporter with a dead flusher thread, and mp children skip the atexit drain
(they exit via os._exit) — so every event recorded in the child was silently
lost. The fix registers os.register_at_fork(after_in_child=…) to rebuild the
flush machinery, plus a multiprocessing.util.Finalize so the child drains
its tail on exit.
"""

import json
import multiprocessing
import sys

import pytest

import scopecall


def _child_records_and_exits(path: str) -> None:
    # Uses the INHERITED singleton — exactly what auto-instrumented code in
    # a forked worker does. Deliberately no flush()/close(): delivery must
    # come from the restarted flusher / the mp Finalize drain.
    sdk = scopecall.get_active()
    assert sdk is not None
    sdk.record_llm_call(
        model="fork-child-model",
        provider="test",
        input_tokens=1,
        output_tokens=1,
        latency_ms=1,
    )


@pytest.mark.skipif(sys.platform == "win32", reason="fork() is Unix-only")
def test_forked_child_events_survive(tmp_path):
    out = tmp_path / "events.ndjson"
    sdk = scopecall.init(output=str(out))
    try:
        sdk.record_llm_call(
            model="parent-model",
            provider="test",
            input_tokens=1,
            output_tokens=1,
            latency_ms=1,
        )
        ctx = multiprocessing.get_context("fork")
        p = ctx.Process(target=_child_records_and_exits, args=(str(out),))
        p.start()
        p.join(15)
        assert p.exitcode == 0
        sdk.flush()
    finally:
        sdk.close(timeout=2.0)

    models = [json.loads(l)["model"] for l in out.read_text().splitlines() if l.strip()]
    assert "parent-model" in models, f"parent event missing: {models}"
    assert "fork-child-model" in models, (
        "child event lost — fork() reinit did not deliver it: %s" % models
    )
