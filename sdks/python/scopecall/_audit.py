"""Prompt-quality audit (Phase B).

The deterministic analyzers in the Go API tell you WHERE your money leaks
(cache blind spots, input bloat, truncation, sequential chains). This module
adds the one class of finding a pure-SQL analyzer can't produce: a critique of
the PROMPT TEXT itself — contradictions, redundancy, ambiguity, cache-hostile
structure — plus a shorter rewrite. It gets that critique the cheap way: by
borrowing the host application's own already-configured LLM client and asking
it to review one representative prompt per distinct prompt-shape, once per
process. The result is stored via the ingest Phase-B endpoints and surfaces in
the dashboard's Optimization Gaps panel as `source="llm_insight"` findings.

Hard guarantees (this code runs inside customer request paths):
  - NEVER raises into host code. Every public entry point swallows all
    exceptions. `maybe_audit` returns immediately; the actual work happens on
    a background daemon thread.
  - NEVER blocks the host thread. The GET-seen / borrowed-completion / POST all
    happen off-thread.
  - Bounded: at most `SCOPECALL_PROMPT_AUDIT_MAX` (default 10) audits per
    process, deduplicated by prompt-shape hash (a local in-process seen-set
    plus a server-side seen check).
  - The borrowed completion runs under `_context.suppress_llm_emit_scope()` so
    the audit call is neither traced nor able to recursively trigger another
    audit.

Wire contract (see RECOMMENDATIONS_CONTRACT.md):
  GET  {ingest_base}/v1/prompt-audit/seen?hash=<h>  -> {"seen": bool}
  POST {ingest_base}/v1/prompt-audit  { prompt_shape_hash, feature_name,
        prompt_version, model, project, audit_model, findings:[...] } -> 202
Both authenticated with the SDK's API key as a Bearer token, exactly like the
event ingest path.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import httpx

from . import _context
from ._version import __version__

if TYPE_CHECKING:
    from ._sdk import ScopeCallSDK

# ── Prompt normalization (for the shape hash) ────────────────────────────────
# The shape hash must be stable across calls that differ only in per-request
# data — a timestamp, a request UUID, a numeric ID. We strip those to a `<N>`
# placeholder so "summarize order 12345 at 2026-07-23T10:00:00Z" and
# "summarize order 67890 at 2026-07-24T11:30:00Z" hash to the SAME shape and
# get audited once, not once per request.
_ISO_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}"                       # date
    r"(?:[T ]\d{2}:\d{2}(?::\d{2})?"           # optional time
    r"(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?"     # optional frac / tz
)
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_DIGITS_RE = re.compile(r"\d{3,}")
_WS_RE = re.compile(r"\s+")

_MIN_PROMPT_CHARS = 200
_DEFAULT_MAX_AUDITS = 10

_VALID_SEVERITY = {"high", "medium", "low"}
_VALID_IMPACT_KIND = {"usd", "tokens_pct", "seconds", "calls", "none"}


META_PROMPT_TEMPLATE = """\
You are a senior prompt engineer reviewing a production LLM prompt for quality
and cost problems.

Critique the prompt shown between the delimiters below for:
1. Contradictions — instructions that conflict with one another.
2. Duplication / redundancy — repeated or restated instructions that waste
   tokens on every call.
3. Ambiguity / confusion — vague wording the model could reasonably
   misinterpret.
4. Structure & cache hygiene — dynamic values (timestamps, IDs, the user's
   message) placed BEFORE the static preamble defeat provider prefix caching;
   the stable, reusable instructions should come first and the variable
   content last.
5. A shorter rewrite — where the same intent can be expressed in materially
   fewer tokens.

Return ONLY a JSON array (no prose, no markdown code fences) of objects. Each
object MUST have EXACTLY these keys:
  "severity"        one of "high", "medium", "low"
  "title"           a short headline
  "detail"          why it is a problem, quoting the specific offending text
  "recommendation"  the concrete action to take
  "impact_kind"     one of "usd", "tokens_pct", "seconds", "calls", "none"
  "impact_value"    a number matching impact_kind (use 0 when unknown)
  "evidence"        the quoted snippet or metric that supports the finding
If the prompt has no meaningful issues, return an empty array: []

--- BEGIN PROMPT ---
__PROMPT__
--- END PROMPT ---
"""


def _normalize_prompt(text: str) -> str:
    """Reduce a prompt to its stable shape: strip per-request noise, collapse
    whitespace. Order matters — ISO timestamps and UUIDs are replaced before
    the generic long-digit-run pass so a whole timestamp collapses to one
    `<N>` rather than being shredded into date/time fragments."""
    t = _ISO_RE.sub("<N>", text)
    t = _UUID_RE.sub("<N>", t)
    t = _DIGITS_RE.sub("<N>", t)
    t = _WS_RE.sub(" ", t).strip()
    return t


def _build_meta_prompt(prompt_text: str) -> str:
    """Embed the target prompt into the meta-prompt. `str.replace` (not
    `.format`) so braces in the target prompt are never treated as format
    fields."""
    return META_PROMPT_TEMPLATE.replace("__PROMPT__", prompt_text)


# ── HTTP shims (module-level so tests can monkeypatch offline) ───────────────


def _http_get(url: str, *, headers: dict, params: dict, timeout: float = 5.0) -> Any:
    return httpx.get(url, headers=headers, params=params, timeout=timeout)


def _http_post(url: str, *, headers: dict, json: dict, timeout: float = 5.0) -> Any:
    return httpx.post(url, headers=headers, json=json, timeout=timeout)


# ── Finding parsing / coercion ───────────────────────────────────────────────


def _parse_findings(raw: Any) -> list[dict]:
    """Extract a JSON array of finding objects from a raw model completion.

    Tolerates markdown ```json fences and leading/trailing prose by grabbing
    the first `[` through the last `]` and json-parsing that slice. Returns []
    on anything unparseable."""
    if not isinstance(raw, str):
        return []
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        data = json.loads(raw[start : end + 1])
    except Exception:
        return []
    return data if isinstance(data, list) else []


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _coerce_severity(value: Any) -> str:
    s = str(value or "").strip().lower()
    return s if s in _VALID_SEVERITY else "medium"


def _coerce_impact_kind(value: Any) -> str:
    s = str(value or "").strip().lower()
    return s if s in _VALID_IMPACT_KIND else "none"


def _coerce_findings(
    items: list,
    *,
    feature_name: str | None,
    prompt_version: str | None,
    model: str,
) -> list[dict]:
    """Coerce raw model output into the canonical Finding shape and stamp the
    invariant scoping fields (source/category/feature/prompt_version/model)."""
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        out.append(
            {
                "category": "prompt_quality",
                "severity": _coerce_severity(it.get("severity")),
                "title": str(it.get("title") or "")[:200],
                "detail": str(it.get("detail") or ""),
                "recommendation": str(it.get("recommendation") or ""),
                "impact_kind": _coerce_impact_kind(it.get("impact_kind")),
                "impact_value": _coerce_float(it.get("impact_value")),
                "evidence": str(it.get("evidence") or ""),
                "model": model or "",
                "feature": feature_name or "",
                "source": "llm_insight",
                "prompt_version": prompt_version or "",
            }
        )
    return out


# ── Manager ──────────────────────────────────────────────────────────────────


class PromptAuditManager:
    """Per-SDK coordinator for prompt-quality audits.

    One instance per SDK (see `get_audit_manager`). Holds the in-process
    dedup seen-set and the per-process audit counter. `maybe_audit` is the
    only method instrumentation calls; everything else is internal.
    """

    def __init__(self, sdk: ScopeCallSDK) -> None:
        self._sdk = sdk
        self._lock = threading.Lock()
        self._seen: set[str] = set()
        self._count = 0
        self._max = _read_max()
        # Retained only so tests can join the background workers deterministically.
        self._threads: list[threading.Thread] = []

    # ── dedup key ────────────────────────────────────────────────────────

    def shape_hash(self, feature_name: str, prompt_text: str) -> str:
        """sha256(feature_name + NUL + normalized_prompt)[:32]. Two prompts
        that differ only in per-request data (dates/UUIDs/long digit runs)
        hash equal; a different feature_name yields a different hash."""
        normalized = _normalize_prompt(prompt_text or "")
        key = (feature_name or "") + "\x00" + normalized
        return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]

    # ── enablement ───────────────────────────────────────────────────────

    def _enabled(self) -> bool:
        cfg = getattr(self._sdk, "_config", None)
        if cfg is None or not getattr(cfg, "prompt_audit", True):
            return False
        # Defensive: honor the env off-switch even for explicit init() users
        # who never went through scopecall.auto.
        pa = os.getenv("SCOPECALL_PROMPT_AUDIT")
        if pa is not None and pa.strip().lower() in ("0", "off", "false", "no"):
            return False
        return True

    # ── entry point ──────────────────────────────────────────────────────

    def maybe_audit(
        self,
        *,
        feature_name: str | None,
        prompt_version: str | None,
        prompt_text: str | None,
        model: str,
        provider: str,
        project: str,
        call_llm: Callable[[str], Any] | None,
    ) -> None:
        """Consider auditing this prompt-shape. Cheap, synchronous, non-blocking.

        No-ops when: disabled, no client closure, prompt too short (<200 chars),
        the process audit cap is reached, we're already inside a suppressed
        (audit / framework-captured) call, or this shape was already scheduled.
        Otherwise it reserves a slot and spawns a daemon thread for the rest.
        """
        try:
            if call_llm is None or not self._enabled():
                return
            # Already inside an audit (or a framework-captured call): never
            # audit-of-an-audit, and never audit LangChain's internal raw calls.
            if _context.suppress_llm_emit():
                return
            if not prompt_text or len(prompt_text) < _MIN_PROMPT_CHARS:
                return

            h = self.shape_hash(feature_name or "", prompt_text)
            with self._lock:
                if self._count >= self._max:
                    return
                if h in self._seen:
                    return
                # Reserve immediately so concurrent calls for the same shape
                # don't both spawn an audit.
                self._seen.add(h)
                self._count += 1
                thread = threading.Thread(
                    target=self._run_audit,
                    kwargs={
                        "shape": h,
                        "feature_name": feature_name,
                        "prompt_version": prompt_version,
                        "prompt_text": prompt_text,
                        "model": model,
                        "provider": provider,
                        "project": project,
                        "call_llm": call_llm,
                    },
                    daemon=True,
                    name="scopecall-prompt-audit",
                )
                self._threads.append(thread)
            thread.start()
        except Exception:  # noqa: BLE001 — must never raise into host code
            pass

    # ── background worker ────────────────────────────────────────────────

    def _run_audit(
        self,
        *,
        shape: str,
        feature_name: str | None,
        prompt_version: str | None,
        prompt_text: str,
        model: str,
        provider: str,
        project: str,
        call_llm: Callable[[str], Any],
    ) -> None:
        try:
            base = self._ingest_base()
            if not base:
                return
            headers = self._auth_headers()
            # Server-side dedup: another process / a prior run may already have
            # audited this shape for the org.
            if self._remote_seen(base, headers, shape):
                return

            meta = _build_meta_prompt(prompt_text)
            raw = self._call_audit_llm(call_llm, meta)
            if raw is None:
                return

            findings = _coerce_findings(
                _parse_findings(raw),
                feature_name=feature_name,
                prompt_version=prompt_version,
                model=model,
            )
            if not findings:
                return

            body = {
                "prompt_shape_hash": shape,
                "feature_name": feature_name or "",
                "prompt_version": prompt_version or "",
                "model": model or "",
                "project": project or "",
                "audit_model": model or "",
                "findings": findings,
            }
            self._post_audit(base, headers, body)
        except Exception:  # noqa: BLE001 — best-effort; never surface
            pass

    def _call_audit_llm(self, call_llm: Callable[[str], Any], meta: str) -> Any:
        """Run the single borrowed completion with emit suppression set, so the
        audit call isn't traced and can't recurse into another audit."""
        try:
            with _context.suppress_llm_emit_scope():
                return call_llm(meta)
        except Exception:  # noqa: BLE001
            return None

    # ── HTTP ─────────────────────────────────────────────────────────────

    def _ingest_base(self) -> str | None:
        """Derive the ingest base URL from the configured event endpoint by
        stripping the trailing `/v1/ingest`."""
        endpoint = getattr(self._sdk._config, "endpoint", None)
        if not endpoint:
            return None
        base = str(endpoint)
        suffix = "/v1/ingest"
        if base.endswith(suffix):
            base = base[: -len(suffix)]
        return base.rstrip("/") or None

    def _auth_headers(self) -> dict:
        key = getattr(self._sdk._config, "api_key", None) or ""
        return {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": f"scopecall-python/{__version__}",
            "X-ScopeCall-SDK": "python",
        }

    def _remote_seen(self, base: str, headers: dict, shape: str) -> bool:
        try:
            resp = _http_get(
                f"{base}/v1/prompt-audit/seen",
                headers=headers,
                params={"hash": shape},
            )
            if getattr(resp, "status_code", None) == 200:
                return bool(resp.json().get("seen"))
        except Exception:  # noqa: BLE001
            pass
        return False

    def _post_audit(self, base: str, headers: dict, body: dict) -> None:
        try:
            _http_post(f"{base}/v1/prompt-audit", headers=headers, json=body)
        except Exception:  # noqa: BLE001
            pass

    # ── test helper ──────────────────────────────────────────────────────

    def _join_all(self, timeout: float = 5.0) -> None:
        """Join any spawned audit threads. Test-only convenience — the audit
        is fire-and-forget in production."""
        with self._lock:
            threads = list(self._threads)
        for t in threads:
            t.join(timeout=timeout)


def _read_max() -> int:
    try:
        return max(0, int(os.getenv("SCOPECALL_PROMPT_AUDIT_MAX", str(_DEFAULT_MAX_AUDITS))))
    except (TypeError, ValueError):
        return _DEFAULT_MAX_AUDITS


# One manager per SDK instance, created on demand and cached ON the SDK object
# (its lifetime is tied to the SDK's, so there's no id()-reuse hazard the way a
# module-level {id(sdk): mgr} dict would have).
_MANAGER_ATTR = "_scopecall_audit_manager"
_MANAGERS_LOCK = threading.Lock()


def get_audit_manager(sdk: ScopeCallSDK) -> PromptAuditManager:
    """Return the (cached) PromptAuditManager for `sdk`.

    Instrumentation calls this on the LLM path, so it must be cheap and never
    raise. The manager holds the dedup seen-set and per-process audit counter,
    and is stored on the SDK instance so it lives and dies with it.
    """
    mgr = getattr(sdk, _MANAGER_ATTR, None)
    if mgr is not None:
        return mgr
    with _MANAGERS_LOCK:
        mgr = getattr(sdk, _MANAGER_ATTR, None)
        if mgr is None:
            mgr = PromptAuditManager(sdk)
            try:
                setattr(sdk, _MANAGER_ATTR, mgr)
            except Exception:  # noqa: BLE001 — fall back to a fresh instance
                pass
        return mgr
