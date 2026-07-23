"""Phase A capture-fix tests (v0.5).

Covers the four capture fixes the deterministic analyzers depend on:
  1. OpenAI cache_read_tokens still wired from prompt_tokens_details.cached_tokens.
  2. DeepSeek (OpenAI-compatible) cache hits read from prompt_cache_hit_tokens.
  3. LangChain cache_read pulled from usage_metadata / response_metadata / llm_output.
  4. Gemini finish_reason normalized from enum/int to the canonical string names
     (so truncation — MAX_TOKENS — is detectable).

All offline: fakes mirror each provider's response shape; events are collected
by overriding the exporter's enqueue (same trick as test_gemini_auto.py)."""

from __future__ import annotations

import types
import uuid

import pytest

import scopecall
from scopecall.instrumentation._gemini import instrument_gemini_module


@pytest.fixture
def sdk():
    s = scopecall.init(debug=True, environment="test", redact_pii=False)
    s._events = []
    s._exporter.enqueue = lambda e: s._events.append(e)  # type: ignore
    yield s
    s.close(timeout=2.0)


def _llm(sdk):
    return [e for e in sdk._events if e.kind == "llm"]


# ── OpenAI / DeepSeek cache read ─────────────────────────────────────────────


def _make_openai_client(usage, *, model="gpt-4o", content="hi"):
    def create(**kwargs):
        return types.SimpleNamespace(
            model=model,
            usage=usage,
            choices=[
                types.SimpleNamespace(
                    message=types.SimpleNamespace(content=content, tool_calls=None),
                    finish_reason="stop",
                )
            ],
        )

    chat = types.SimpleNamespace(
        completions=types.SimpleNamespace(create=create)
    )
    return types.SimpleNamespace(chat=chat)


def test_openai_cached_tokens_still_wired(sdk):
    usage = types.SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=20,
        prompt_tokens_details=types.SimpleNamespace(cached_tokens=30),
    )
    client = sdk.instrument(_make_openai_client(usage, model="gpt-4o"))
    client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": "Hi"}]
    )
    ev = _llm(sdk)[0]
    assert ev.cache_read_tokens == 30


def test_openai_deepseek_prompt_cache_hit_fallback(sdk):
    # DeepSeek flows through the OpenAI client and reports cache hits as a flat
    # usage.prompt_cache_hit_tokens (no prompt_tokens_details).
    usage = types.SimpleNamespace(
        prompt_tokens=1000,
        completion_tokens=50,
        prompt_cache_hit_tokens=768,
    )
    client = sdk.instrument(_make_openai_client(usage, model="deepseek-chat"))
    client.chat.completions.create(
        model="deepseek-chat", messages=[{"role": "user", "content": "Hi"}]
    )
    ev = _llm(sdk)[0]
    assert ev.cache_read_tokens == 768


def test_openai_no_cache_info_stays_none(sdk):
    usage = types.SimpleNamespace(prompt_tokens=10, completion_tokens=5)
    client = sdk.instrument(_make_openai_client(usage, model="gpt-4o"))
    client.chat.completions.create(
        model="gpt-4o", messages=[{"role": "user", "content": "Hi"}]
    )
    ev = _llm(sdk)[0]
    assert ev.cache_read_tokens is None


# ── LangChain cache read ─────────────────────────────────────────────────────


def _run_langchain(sdk, result):
    from scopecall.integrations.langchain import ScopeCallCallbackHandler

    h = ScopeCallCallbackHandler(sdk)
    rid = uuid.uuid4()
    with sdk.workflow("w"):
        h.on_llm_start({}, ["p"], run_id=rid)
        h.on_llm_end(result, run_id=rid)
    return _llm(sdk)[0]


def test_langchain_cache_read_from_usage_metadata(sdk):
    msg = types.SimpleNamespace(
        usage_metadata={
            "input_tokens": 100,
            "output_tokens": 20,
            "input_token_details": {"cache_read": 64},
        }
    )
    result = types.SimpleNamespace(
        llm_output={
            "model_name": "gpt-4o",
            "token_usage": {"prompt_tokens": 100, "completion_tokens": 20},
        },
        generations=[[types.SimpleNamespace(message=msg)]],
    )
    ev = _run_langchain(sdk, result)
    assert ev.cache_read_tokens == 64
    assert ev.input_tokens == 100 and ev.output_tokens == 20


def test_langchain_cache_read_from_llm_output_prompt_tokens_details(sdk):
    result = types.SimpleNamespace(
        llm_output={
            "model_name": "gpt-4o",
            "token_usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "prompt_tokens_details": {"cached_tokens": 50},
            },
        },
        generations=[],
    )
    ev = _run_langchain(sdk, result)
    assert ev.cache_read_tokens == 50


def test_langchain_no_cache_info_stays_none(sdk):
    result = types.SimpleNamespace(
        llm_output={
            "model_name": "gpt-4o",
            "token_usage": {"prompt_tokens": 100, "completion_tokens": 20},
        },
        generations=[],
    )
    ev = _run_langchain(sdk, result)
    assert ev.cache_read_tokens is None


# ── Gemini finish_reason normalization ───────────────────────────────────────


def _make_fake_genai(finish_reason):
    class _Usage:
        prompt_token_count = 10
        candidates_token_count = 5
        total_token_count = 15

    class _Resp:
        text = "hi back"
        usage_metadata = _Usage()
        candidates = [types.SimpleNamespace(finish_reason=finish_reason)]

    class GenerativeModel:
        def __init__(self, model_name):
            self.model_name = model_name

        def generate_content(self, contents, **kwargs):
            return _Resp()

    mod = types.ModuleType("google.generativeai")
    mod.GenerativeModel = GenerativeModel
    return mod


@pytest.mark.parametrize(
    "raw,expected",
    [
        (2, "MAX_TOKENS"),      # int enum value → truncation, now detectable
        (1, "STOP"),
        (3, "SAFETY"),
        ("2", "MAX_TOKENS"),    # raw digit string
        ("STOP", "STOP"),       # already-normalized string passes through
    ],
)
def test_gemini_finish_reason_normalized(sdk, raw, expected):
    genai = _make_fake_genai(raw)
    instrument_gemini_module(genai, sdk)
    genai.GenerativeModel("gemini-3-flash").generate_content("hi")
    assert _llm(sdk)[0].finish_reason == expected


def test_gemini_finish_reason_enum_uses_name(sdk):
    enum_like = types.SimpleNamespace(name="RECITATION")
    genai = _make_fake_genai(enum_like)
    instrument_gemini_module(genai, sdk)
    genai.GenerativeModel("gemini-3-flash").generate_content("hi")
    assert _llm(sdk)[0].finish_reason == "RECITATION"
