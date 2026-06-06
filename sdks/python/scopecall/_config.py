"""SDK configuration.

Matches the TS SDK's `ScopeCallConfig` shape (sdks/typescript/src/config.ts)
field-for-field where it makes sense. Naming follows Python conventions
(`snake_case`, `bool` defaults) — the field set itself is parity.

Round-8 review made `endpoint` required when `api_key` is set: a missing
endpoint used to silently default to https://ingest.scopecall.com/v1/ingest
which doesn't exist yet (hosted Cloud isn't live). Python now follows the
same contract — fail loud with a `ConfigError` that names the fix.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(ValueError):
    """Raised by `init(...)` when the config is internally inconsistent.

    Subclasses `ValueError` so existing try/except blocks that catch the
    base class still work; the named subclass lets careful callers
    distinguish config errors from other ValueError sources.
    """


@dataclass
class ScopeCallConfig:
    # ── Transport selection ──────────────────────────────────────────────
    # Exactly one of api_key / output / debug must be set. Mirrors TS.
    api_key: str | None = None

    # `endpoint` is REQUIRED when api_key is set (Round-8 review). For
    # self-hosted, point at the Rust ingest URL, e.g.
    # http://localhost:8080/v1/ingest. For hosted Cloud — not yet live —
    # this default will be reintroduced.
    endpoint: str | None = None

    # Debug mode pretty-prints to stdout instead of shipping events.
    # Useful during integration. Overrides api_key + output.
    debug: bool = False

    # File mode appends NDJSON events to the given path. Useful for local
    # batch capture without a running ingest service.
    output: str | None = None

    # ── Behavior ─────────────────────────────────────────────────────────
    environment: str = "production"
    redact_pii: bool = True
    capture_content: bool = True

    # ── Auto-flush ───────────────────────────────────────────────────────
    # Background thread flushes the queue this often (seconds). 5 s aligns
    # with the TS SDK's flushIntervalMs=5000 default. The first-run UI's
    # 3 s pre-first-call poll cadence is intentionally faster than this
    # so the dashboard catches the first trace within ~8 s end-to-end.
    flush_interval: float = 5.0
    batch_size: int = 50
    queue_max_size: int = 10_000
    max_retries: int = 3

    # ── Off-switch ───────────────────────────────────────────────────────
    # When True, `init()` returns a no-op SDK that swallows every call.
    # Useful in tests that import production code paths but don't want
    # network IO. Mirrors TS `ScopeCallConfig.disabled`.
    disabled: bool = False

    # ── Defaults applied to every event ──────────────────────────────────
    # Each of these is overridable per-trace via sdk.trace(...).
    default_feature: str | None = None
    default_user_id: str | None = None
    default_session_id: str | None = None

    # v0.3 — when True, every event is tagged is_test=True. Use this for
    # eval suites, CI runs, smoke tests, replays, and backfills so the
    # dashboard can exclude them from production cost reports. Also
    # settable via the SCOPECALL_TEST=true env var (resolved in
    # __post_init__). Tri-state: None means "consult env"; True/False
    # is an explicit override of the env var.
    test: bool | None = None

    # Round-4 review (TS): default_prompt_version tags every call with a
    # build/commit/release identifier when the app has a single canonical
    # prompt set. Per-trace prompt_version wins, then parent trace's
    # value, then this default, then None.
    default_prompt_version: str | None = None

    def __post_init__(self) -> None:
        # Serverless guard: a zero or negative interval would spin the
        # flush thread. Clamp to 0.1 s rather than reject — the user
        # probably meant "flush often" and we want to be forgiving.
        if self.flush_interval <= 0:
            self.flush_interval = 0.1

        # v0.3 — resolve the test flag. Tri-state: None means "consult
        # the SCOPECALL_TEST env var"; explicit True/False overrides.
        # Common pattern: pytest fixtures and CI pipelines set
        # SCOPECALL_TEST=true once at the process level so every run
        # gets tagged is_test=True without app-code changes.
        if self.test is None:
            self.test = os.environ.get("SCOPECALL_TEST", "").lower() in (
                "1", "true", "yes", "on",
            )

    @property
    def mode(self) -> str:
        """Which transport `init()` should select for this config."""
        if self.disabled:
            return "noop"
        if self.debug:
            return "console"
        if self.output:
            return "file"
        return "api"


def validate(config: ScopeCallConfig) -> None:
    """Raise ConfigError if the config can't possibly produce a working SDK.

    Three valid configurations:
      1. debug=True            → console mode (no api_key needed)
      2. output=<path>         → file mode (no api_key needed)
      3. api_key + endpoint    → HTTP mode (BOTH required since Round-8)

    `disabled=True` shorts the entire SDK to no-ops; we don't bother
    validating in that case because the SDK never sends anything anyway.
    """
    if config.disabled:
        return
    if config.debug:
        return
    if config.output:
        return
    if not config.api_key:
        raise ConfigError(
            "scopecall.init() requires one of: api_key=..., debug=True, or output=<path>."
        )
    # Round-8: endpoint is now required alongside api_key. No silent
    # fallback to a hosted-Cloud URL that doesn't exist yet.
    if not config.endpoint:
        raise ConfigError(
            "scopecall.init(api_key=...) requires endpoint=... "
            "Self-hosted: point at your ingest service, e.g. "
            "endpoint='http://localhost:8080/v1/ingest'. "
            "(ScopeCall Cloud is not yet available; a managed default "
            "endpoint will return in a future release.)"
        )
