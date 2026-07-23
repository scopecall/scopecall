"""Phase B prompt-audit tests (v0.5).

Offline: the borrowed LLM client is a canned closure and the ingest HTTP is
monkeypatched at the module's `_http_get` / `_http_post` shims. `_join_all`
joins the background daemon threads so assertions are deterministic."""

from __future__ import annotations

import types

import scopecall
from scopecall import _audit
from scopecall._audit import _parse_findings, get_audit_manager

# ── shape_hash ───────────────────────────────────────────────────────────────


def test_shape_hash_ignores_dates_uuids_and_numbers():
    sdk = scopecall.init(debug=True)
    try:
        mgr = get_audit_manager(sdk)
        p1 = (
            "Summarize order 12345 placed at 2026-07-23T10:15:30Z for account "
            "550e8400-e29b-41d4-a716-446655440000. Give a concise summary."
        )
        p2 = (
            "Summarize order 98765 placed at 2026-01-02T23:59:59Z for account "
            "123e4567-e89b-12d3-a456-426614174000. Give a concise summary."
        )
        # Differ ONLY in a date, a UUID, and numeric IDs → same shape.
        assert mgr.shape_hash("feat", p1) == mgr.shape_hash("feat", p2)
    finally:
        sdk.close(timeout=1.0)


def test_shape_hash_differs_by_feature():
    sdk = scopecall.init(debug=True)
    try:
        mgr = get_audit_manager(sdk)
        p = "the same identical prompt text with no variable parts anywhere"
        assert mgr.shape_hash("featA", p) != mgr.shape_hash("featB", p)
    finally:
        sdk.close(timeout=1.0)


# ── _parse_findings tolerance ────────────────────────────────────────────────


def test_parse_findings_extracts_from_fenced_prose():
    raw = 'Sure, here is the review:\n```json\n[{"severity":"low"}]\n```\nHope it helps.'
    out = _parse_findings(raw)
    assert isinstance(out, list) and out and out[0]["severity"] == "low"


def test_parse_findings_bad_input_returns_empty():
    assert _parse_findings("no json array here") == []
    assert _parse_findings(None) == []
    assert _parse_findings("{not: a list}") == []


# ── maybe_audit end-to-end (fake client + monkeypatched ingest) ──────────────


def _resp(status_code, payload):
    return types.SimpleNamespace(status_code=status_code, json=lambda: payload)


def _api_sdk(**over):
    kw = dict(
        api_key="k",
        endpoint="http://localhost:8080/v1/ingest",
        flush_interval=0.1,
    )
    kw.update(over)
    return scopecall.init(**kw)


def test_maybe_audit_posts_findings(monkeypatch):
    sdk = _api_sdk()
    try:
        gets: list = []
        posts: list = []

        def fake_get(url, *, headers, params, timeout=5.0):
            gets.append((url, headers, params))
            return _resp(200, {"seen": False})

        def fake_post(url, *, headers, json, timeout=5.0):
            posts.append((url, headers, json))
            return _resp(202, {})

        monkeypatch.setattr(_audit, "_http_get", fake_get)
        monkeypatch.setattr(_audit, "_http_post", fake_post)

        canned = (
            "Here are the issues I found:\n```json\n"
            '[{"severity":"high","title":"Contradiction","detail":"d",'
            '"recommendation":"r","impact_kind":"tokens_pct","impact_value":12.5,'
            '"evidence":"e"}]\n```'
        )
        prompt = "P" * 250
        mgr = get_audit_manager(sdk)
        mgr.maybe_audit(
            feature_name="strategy_step",
            prompt_version="v3",
            prompt_text=prompt,
            model="ft:gpt-4.1",
            provider="openai",
            project="sp-optimizer",
            call_llm=lambda p: canned,
        )
        mgr._join_all(timeout=5.0)

        # Seen-check hit the right URL with the shape hash.
        assert len(gets) == 1
        get_url, get_headers, get_params = gets[0]
        assert get_url == "http://localhost:8080/v1/prompt-audit/seen"
        assert get_headers["Authorization"] == "Bearer k"
        assert get_params == {"hash": mgr.shape_hash("strategy_step", prompt)}

        # Findings POSTed with the invariant scoping fields stamped.
        assert len(posts) == 1
        post_url, post_headers, body = posts[0]
        assert post_url == "http://localhost:8080/v1/prompt-audit"
        assert post_headers["Authorization"] == "Bearer k"
        assert body["prompt_shape_hash"] == mgr.shape_hash("strategy_step", prompt)
        assert body["feature_name"] == "strategy_step"
        assert body["prompt_version"] == "v3"
        assert body["model"] == "ft:gpt-4.1"
        assert body["project"] == "sp-optimizer"
        assert body["audit_model"] == "ft:gpt-4.1"
        f = body["findings"][0]
        assert f["source"] == "llm_insight"
        assert f["category"] == "prompt_quality"
        assert f["feature"] == "strategy_step"
        assert f["prompt_version"] == "v3"
        assert f["model"] == "ft:gpt-4.1"
        assert f["severity"] == "high"
        assert f["impact_kind"] == "tokens_pct"
        assert f["impact_value"] == 12.5
    finally:
        sdk.close(timeout=2.0)


def test_maybe_audit_skips_when_remote_seen(monkeypatch):
    sdk = _api_sdk()
    try:
        posts: list = []
        monkeypatch.setattr(
            _audit, "_http_get",
            lambda url, *, headers, params, timeout=5.0: _resp(200, {"seen": True}),
        )
        monkeypatch.setattr(
            _audit, "_http_post",
            lambda url, *, headers, json, timeout=5.0: posts.append(json),
        )
        mgr = get_audit_manager(sdk)
        mgr.maybe_audit(
            feature_name="f", prompt_version="v", prompt_text="Q" * 250,
            model="m", provider="openai", project="p", call_llm=lambda p: "[]",
        )
        mgr._join_all(timeout=5.0)
        assert posts == []
    finally:
        sdk.close(timeout=2.0)


def test_maybe_audit_dedups_same_shape(monkeypatch):
    sdk = _api_sdk()
    try:
        calls = {"llm": 0}
        monkeypatch.setattr(
            _audit, "_http_get",
            lambda url, *, headers, params, timeout=5.0: _resp(200, {"seen": False}),
        )
        monkeypatch.setattr(
            _audit, "_http_post",
            lambda url, *, headers, json, timeout=5.0: _resp(202, {}),
        )

        def call_llm(p):
            calls["llm"] += 1
            return (
                '[{"severity":"low","title":"t","detail":"d","recommendation":"r",'
                '"impact_kind":"none","impact_value":0,"evidence":"e"}]'
            )

        mgr = get_audit_manager(sdk)
        text = "R" * 250
        for _ in range(2):
            mgr.maybe_audit(
                feature_name="f", prompt_version="v", prompt_text=text,
                model="m", provider="openai", project="p", call_llm=call_llm,
            )
        mgr._join_all(timeout=5.0)
        assert calls["llm"] == 1  # second call deduped by shape hash
    finally:
        sdk.close(timeout=2.0)


def test_maybe_audit_disabled_via_config(monkeypatch):
    sdk = _api_sdk(prompt_audit=False)
    try:
        posts: list = []
        monkeypatch.setattr(
            _audit, "_http_post",
            lambda url, *, headers, json, timeout=5.0: posts.append(json),
        )
        mgr = get_audit_manager(sdk)
        mgr.maybe_audit(
            feature_name="f", prompt_version="v", prompt_text="S" * 250,
            model="m", provider="openai", project="p", call_llm=lambda p: "[]",
        )
        mgr._join_all(timeout=5.0)
        assert posts == []
    finally:
        sdk.close(timeout=2.0)


def test_maybe_audit_skips_short_prompt(monkeypatch):
    sdk = _api_sdk()
    try:
        hits = {"n": 0}

        def fake_get(url, *, headers, params, timeout=5.0):
            hits["n"] += 1
            return _resp(200, {"seen": False})

        monkeypatch.setattr(_audit, "_http_get", fake_get)
        mgr = get_audit_manager(sdk)
        mgr.maybe_audit(
            feature_name="f", prompt_version="v", prompt_text="too short",
            model="m", provider="openai", project="p", call_llm=lambda p: "[]",
        )
        mgr._join_all(timeout=5.0)
        assert hits["n"] == 0  # never even reached the seen-check
    finally:
        sdk.close(timeout=2.0)


def test_maybe_audit_noop_while_suppressed(monkeypatch):
    # The suppression guard is what prevents an audit-of-an-audit (and stops us
    # auditing framework-internal calls that a callback is already capturing).
    from scopecall import _context

    sdk = _api_sdk()
    try:
        posts: list = []
        monkeypatch.setattr(
            _audit, "_http_get",
            lambda url, *, headers, params, timeout=5.0: _resp(200, {"seen": False}),
        )
        monkeypatch.setattr(
            _audit, "_http_post",
            lambda url, *, headers, json, timeout=5.0: posts.append(json),
        )
        mgr = get_audit_manager(sdk)
        tok = _context.set_suppress_llm_emit(True)
        try:
            mgr.maybe_audit(
                feature_name="f", prompt_version="v", prompt_text="T" * 250,
                model="m", provider="openai", project="p", call_llm=lambda p: "[]",
            )
        finally:
            _context.reset_suppress_llm_emit(tok)
        mgr._join_all(timeout=5.0)
        assert posts == []
    finally:
        sdk.close(timeout=2.0)


def test_maybe_audit_respects_process_cap(monkeypatch):
    monkeypatch.setenv("SCOPECALL_PROMPT_AUDIT_MAX", "2")
    sdk = _api_sdk()
    try:
        calls = {"llm": 0}
        monkeypatch.setattr(
            _audit, "_http_get",
            lambda url, *, headers, params, timeout=5.0: _resp(200, {"seen": False}),
        )
        monkeypatch.setattr(
            _audit, "_http_post",
            lambda url, *, headers, json, timeout=5.0: _resp(202, {}),
        )

        def call_llm(p):
            calls["llm"] += 1
            return (
                '[{"severity":"low","title":"t","detail":"d","recommendation":"r",'
                '"impact_kind":"none","impact_value":0,"evidence":"e"}]'
            )

        mgr = get_audit_manager(sdk)
        # Three DISTINCT shapes (different feature names) — cap is 2.
        for feat in ("a", "b", "c"):
            mgr.maybe_audit(
                feature_name=feat, prompt_version="v", prompt_text="U" * 250,
                model="m", provider="openai", project="p", call_llm=call_llm,
            )
        mgr._join_all(timeout=5.0)
        assert calls["llm"] == 2  # capped at SCOPECALL_PROMPT_AUDIT_MAX
    finally:
        sdk.close(timeout=2.0)
