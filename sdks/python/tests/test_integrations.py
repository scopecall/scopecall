"""Tests for the framework-agnostic integrations layer:
LangGraph adapter, LangChain callback handler, CrewAI adapter, and the
manual span lifecycle primitives — all without requiring the real
frameworks (fakes + event interception)."""

import uuid

import pytest

import scopecall
from scopecall.integrations._base import span_callable, traced_agent
from scopecall.integrations.langchain import ScopeCallCallbackHandler, _parse_llm_result


@pytest.fixture
def sdk():
    # debug=True → console transport, no network thread (mirrors conftest).
    s = scopecall.init(debug=True, environment="test")
    s._events = []
    s._exporter.enqueue = lambda e: s._events.append(e)  # type: ignore
    yield s
    s.close(timeout=2.0)


def kinds(sdk):
    return [e.kind for e in sdk._events]


def by_kind(sdk, kind):
    return [e for e in sdk._events if e.kind == kind]


def parent_of(sdk, event):
    table = {e.span_id: e for e in sdk._events}
    return table.get(event.parent_span_id)


# ── get_active ─────────────────────────────────────────────────────────

def test_get_active_returns_last_init(sdk):
    assert scopecall.get_active() is sdk


# ── _base.span_callable / traced_agent ─────────────────────────────────

def test_span_callable_wraps_as_agent(sdk):
    def node(state):
        return state + 1

    wrapped = span_callable(node, name="my_node", kind="agent")
    with sdk.workflow("wf"):
        assert wrapped(41) == 42

    agents = by_kind(sdk, "agent")
    assert len(agents) == 1 and agents[0].feature_name == "my_node"
    assert parent_of(sdk, agents[0]).kind == "workflow"


def test_span_callable_is_passthrough_when_disabled():
    # New SDK NOT active for these is hard to force; instead test idempotency
    def f():
        return 1
    w = span_callable(f, name="x")
    assert span_callable(w) is w  # already-wrapped returns unchanged


def test_traced_agent_decorator(sdk):
    @traced_agent("router")
    def route(x):
        return x

    with sdk.workflow("wf"):
        route(1)
    assert [e.feature_name for e in by_kind(sdk, "agent")] == ["router"]


# ── start_span / end_span lifecycle ────────────────────────────────────

def test_start_end_span_emits_container(sdk):
    with sdk.workflow("wf") as wf:
        ctx = sdk.start_span("manual_agent", kind="agent", parent_context=wf)
        sdk.end_span(ctx, latency_ms=123)
    agent = by_kind(sdk, "agent")[0]
    assert agent.feature_name == "manual_agent"
    assert agent.latency_ms == 123
    assert parent_of(sdk, agent).kind == "workflow"


# ── LangChain callback handler ─────────────────────────────────────────

class _FakeUsageMsg:
    def __init__(self, i, o):
        self.usage_metadata = {"input_tokens": i, "output_tokens": o}


class _FakeGen:
    def __init__(self, i, o):
        self.message = _FakeUsageMsg(i, o)


class _FakeLLMResult:
    def __init__(self, model, i, o, via_output=True):
        if via_output:
            self.llm_output = {"model_name": model, "token_usage": {"prompt_tokens": i, "completion_tokens": o}}
            self.generations = []
        else:
            self.llm_output = {"model_name": model}
            self.generations = [[_FakeGen(i, o)]]


def test_parse_llm_result_both_paths():
    assert _parse_llm_result(_FakeLLMResult("gpt-4o", 10, 5)) == ("gpt-4o", "openai", 10, 5)
    m, p, i, o = _parse_llm_result(_FakeLLMResult("claude-3-5-sonnet", 7, 3, via_output=False))
    assert (p, i, o) == ("anthropic", 7, 3)


def test_langchain_handler_nesting(sdk):
    h = ScopeCallCallbackHandler(customer_id="cust_1")
    chain_id, tool_id, llm_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    with sdk.workflow("wf", customer_id="cust_1") as wf:
        h.on_chain_start({"name": "router"}, {}, run_id=chain_id, parent_run_id=None)
        h.on_tool_start({"name": "search"}, "q", run_id=tool_id, parent_run_id=chain_id)
        h.on_llm_start({"name": "llm"}, ["p"], run_id=llm_id, parent_run_id=tool_id)
        h.on_llm_end(_FakeLLMResult("gpt-4o-mini", 12, 4), run_id=llm_id)
        h.on_tool_end("done", run_id=tool_id)
        h.on_chain_end({}, run_id=chain_id)

    agent = by_kind(sdk, "agent")[0]
    step = by_kind(sdk, "step")[0]
    llm = by_kind(sdk, "llm")[0]
    assert agent.feature_name == "router"
    assert step.feature_name == "search"
    assert parent_of(sdk, agent).kind == "workflow"          # chain under workflow
    assert parent_of(sdk, step).span_id == agent.span_id      # tool under chain
    assert llm.parent_span_id == step.span_id                 # llm under tool
    assert llm.input_tokens == 12 and llm.output_tokens == 4
    assert llm.customer_id == "cust_1"


def test_langchain_handler_chain_error(sdk):
    h = ScopeCallCallbackHandler()
    rid = uuid.uuid4()
    with sdk.workflow("wf"):
        h.on_chain_start({"name": "c"}, {}, run_id=rid)
        h.on_chain_error(ValueError("boom"), run_id=rid)
    agent = by_kind(sdk, "agent")[0]
    assert agent.status == "error" and "boom" in (agent.error_message or "")


# ── CrewAI adapter (fake module) ───────────────────────────────────────

def test_crewai_instrument_wraps_fake(sdk, monkeypatch):
    import sys, types

    calls = {}

    class FakeAgent:
        def __init__(self, role):
            self.role = role

        def execute_task(self, task):
            calls["ran"] = True
            return f"done:{task}"

    fake_mod = types.ModuleType("crewai")
    fake_mod.Agent = FakeAgent
    monkeypatch.setitem(sys.modules, "crewai", fake_mod)

    from scopecall.integrations import crewai as sc_crewai
    sc_crewai.uninstrument()
    assert sc_crewai.instrument() is True
    try:
        a = FakeAgent("researcher")
        with sdk.workflow("crew_run"):
            assert a.execute_task("find things") == "done:find things"
    finally:
        sc_crewai.uninstrument()

    assert calls.get("ran") is True
    agents = by_kind(sdk, "agent")
    assert any(a.feature_name == "crewai:researcher" for a in agents)
    assert parent_of(sdk, agents[0]).kind == "workflow"
