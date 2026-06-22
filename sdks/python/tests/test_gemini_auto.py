"""Gemini instrumentation + auto-agent patcher tests, using fakes (no real
google-generativeai / openai installed required)."""

import types

import pytest

import scopecall
from scopecall.instrumentation._gemini import instrument_gemini_module
from scopecall.auto import _patch_openai, _patch_gemini, _truthy


@pytest.fixture
def sdk():
    s = scopecall.init(debug=True, environment="test")
    s._events = []
    s._exporter.enqueue = lambda e: s._events.append(e)  # type: ignore
    yield s
    s.close(timeout=2.0)


def llm_events(sdk):
    return [e for e in sdk._events if e.kind == "llm"]


# ── fake Gemini ───────────────────────────────────────────────────────────────
class _Usage:
    def __init__(self, i, o):
        self.prompt_token_count = i
        self.candidates_token_count = o
        self.total_token_count = i + o


class _GResp:
    def __init__(self, text, i, o):
        self.text = text
        self.usage_metadata = _Usage(i, o)
        self.candidates = [types.SimpleNamespace(finish_reason="STOP")]


def _make_fake_genai():
    class GenerativeModel:
        def __init__(self, model_name):
            self.model_name = model_name

        def generate_content(self, contents, **kwargs):
            return _GResp("hello back", 120, 48)

    mod = types.ModuleType("google.generativeai")
    mod.GenerativeModel = GenerativeModel
    return mod


def test_gemini_instrumentation_emits(sdk):
    genai = _make_fake_genai()
    instrument_gemini_module(genai, sdk)
    model = genai.GenerativeModel("models/gemini-3-flash-preview")
    resp = model.generate_content("optimize this campaign")
    assert resp.text == "hello back"
    ev = llm_events(sdk)
    assert len(ev) == 1
    assert ev[0].provider == "google"
    assert ev[0].model == "gemini-3-flash-preview"  # "models/" stripped
    assert ev[0].input_tokens == 120
    assert ev[0].output_tokens == 48
    assert ev[0].finish_reason == "STOP"


def test_gemini_idempotent(sdk):
    genai = _make_fake_genai()
    instrument_gemini_module(genai, sdk)
    instrument_gemini_module(genai, sdk)  # twice → no double wrap
    genai.GenerativeModel("gemini-3-flash-preview").generate_content("hi")
    assert len(llm_events(sdk)) == 1


def test_gemini_error_status(sdk):
    genai = _make_fake_genai()

    def boom(self, contents, **k):
        raise RuntimeError("429 quota exceeded")

    genai.GenerativeModel.generate_content = boom
    instrument_gemini_module(genai, sdk)
    with pytest.raises(RuntimeError):
        genai.GenerativeModel("gemini-3-flash-preview").generate_content("hi")
    ev = llm_events(sdk)
    assert len(ev) == 1 and ev[0].status == "rate_limited"


# ── fake OpenAI for the auto patcher ──────────────────────────────────────────
def _make_fake_openai():
    class _Resp:
        model = "gpt-4o-mini"
        usage = types.SimpleNamespace(prompt_tokens=10, completion_tokens=5, prompt_tokens_details=None)
        choices = [types.SimpleNamespace(message=types.SimpleNamespace(content="hi", tool_calls=None), finish_reason="stop")]

    class _Completions:
        def create(self, **kwargs):
            return _Resp()

    class _Chat:
        def __init__(self):
            self.completions = _Completions()

    class OpenAI:
        def __init__(self, *a, **k):
            self.chat = _Chat()

    mod = types.ModuleType("openai")
    mod.OpenAI = OpenAI
    return mod


def test_auto_patch_openai_instruments_every_client(sdk):
    openai_mod = _make_fake_openai()
    _patch_openai(openai_mod, sdk)
    # constructing a client (even after patching) auto-instruments it
    client = openai_mod.OpenAI(api_key="x")
    client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])
    ev = llm_events(sdk)
    assert len(ev) == 1 and ev[0].provider == "openai" and ev[0].input_tokens == 10


def test_auto_patch_gemini(sdk):
    genai = _make_fake_genai()
    _patch_gemini(genai, sdk)
    genai.GenerativeModel("gemini-3-flash-preview").generate_content("hi")
    assert len(llm_events(sdk)) == 1


def test_truthy():
    assert _truthy("1") and _truthy("true") and _truthy("YES")
    assert not _truthy("") and not _truthy(None) and not _truthy("0")


def test_provider_emit_suppressed_when_flag_set(sdk):
    """The raw provider emit() must no-op while the suppress flag is set
    (so a LangChain callback can be the single source of truth)."""
    from scopecall import _context
    genai = _make_fake_genai()
    instrument_gemini_module(genai, sdk)
    model = genai.GenerativeModel("gemini-3-flash-preview")
    model.generate_content("a")
    assert len(llm_events(sdk)) == 1
    tok = _context.set_suppress_llm_emit(True)
    try:
        model.generate_content("b")  # suppressed
    finally:
        _context.reset_suppress_llm_emit(tok)
    assert len(llm_events(sdk)) == 1  # no duplicate
    model.generate_content("c")
    assert len(llm_events(sdk)) == 2  # back to normal


def test_gemini_thinking_tokens_counted(sdk):
    """gemini-3 thinking models bill reasoning under thoughts_token_count;
    they must be counted as output so cost isn't lost."""
    genai = _make_fake_genai()

    class _U:
        prompt_token_count = 100
        candidates_token_count = 0
        thoughts_token_count = 40
        total_token_count = 140

    class _R:
        text = "x"
        usage_metadata = _U()
        candidates = [types.SimpleNamespace(finish_reason="STOP")]

    genai.GenerativeModel.generate_content = lambda self, c, **k: _R()
    instrument_gemini_module(genai, sdk)
    genai.GenerativeModel("gemini-3-pro-preview").generate_content("hi")
    ev = llm_events(sdk)[0]
    assert ev.input_tokens == 100
    assert ev.output_tokens == 40  # thoughts counted as output


def test_langchain_llm_only_dedups_raw_provider(sdk):
    """llm_only handler captures the call (with usage_metadata tokens) and
    suppresses the raw provider duplicate; no chain/agent span created."""
    import uuid
    from scopecall.integrations.langchain import ScopeCallCallbackHandler

    genai = _make_fake_genai()
    instrument_gemini_module(genai, sdk)
    h = ScopeCallCallbackHandler(sdk, llm_only=True)
    rid = uuid.uuid4()

    class _Result:
        llm_output = {"model_name": "gpt-4o", "token_usage": {"prompt_tokens": 11, "completion_tokens": 7}}
        generations = []

    with sdk.workflow("w", customer_id="c"):
        h.on_llm_start({}, ["p"], run_id=rid)  # sets suppress
        genai.GenerativeModel("gemini-3-flash-preview").generate_content("x")  # raw → suppressed
        h.on_llm_end(_Result(), run_id=rid)    # resets + emits with usage_metadata tokens

    ev = llm_events(sdk)
    assert len(ev) == 1                         # raw provider dup suppressed
    assert ev[0].input_tokens == 11 and ev[0].output_tokens == 7
    assert ev[0].customer_id == "c"
    # llm_only → no agent/step container spans from the handler
    assert all(e.kind == "llm" or e.kind == "workflow" for e in sdk._events)


def test_thread_context_propagation_attributes_threaded_calls(sdk):
    """A Gemini call made inside a ThreadPoolExecutor must attribute to the
    enclosing workflow/agent span (the orphan bug fix)."""
    from concurrent.futures import ThreadPoolExecutor
    from scopecall.auto import _patch_thread_context_propagation

    _patch_thread_context_propagation()
    genai = _make_fake_genai()
    instrument_gemini_module(genai, sdk)

    with sdk.workflow("run", customer_id="io_1") as wf:
        with sdk.agent("strategy") as agent_ctx:
            def work():
                # runs in a worker thread — contextvars would be empty here
                # without the propagation patch.
                genai.GenerativeModel("gemini-3-flash-preview").generate_content("hi")
            with ThreadPoolExecutor(max_workers=2) as ex:
                ex.submit(work).result()
                ex.submit(work).result()

    llm = llm_events(sdk)
    assert len(llm) == 2
    # both threaded calls attribute to the strategy agent + carry the customer
    assert all(e.parent_span_id == agent_ctx.span_id for e in llm)
    assert all(e.customer_id == "io_1" for e in llm)
    assert all(e.trace_id == wf.trace_id for e in llm)
