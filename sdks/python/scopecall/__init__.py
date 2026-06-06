"""ScopeCall — source-available, self-hostable AI observability for Python.

Quick start:

    import scopecall
    from openai import OpenAI

    sdk = scopecall.init(
        api_key="sc_live_xxx",
        endpoint="http://localhost:8080/v1/ingest",
    )

    # Native OpenAI / Anthropic instrumentation:
    openai_client = sdk.instrument(OpenAI())

    with sdk.trace("support-agent", user_id="user_123") as ctx:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "Help me with my refund"}],
        )

    # Manual API (LangChain / LlamaIndex / RAG / custom wrappers):
    with sdk.trace("custom-agent", user_id="user_456"):
        sdk.record_llm_call(
            model="gpt-4o-mini",
            provider="openai",
            input_tokens=120, output_tokens=48,
            latency_ms=842,
            input_text="Help me with my refund",
            output_text="...",
        )

    sdk.close()  # graceful shutdown — flushes the queue


API surface:

    init(...)          → ScopeCallSDK instance
    ScopeCallSDK       → trace(name) /
                         workflow(name) / agent(name) / step(name) /
                         instrument(client, provider="openai"|"anthropic") /
                         record_llm_call(...) / add_redaction_pattern(...) /
                         flush() / close()
    ScopeCallConfig    → typed config dataclass for dependency-injection style
    ConfigError        → raised when init() gets an invalid config
    LLMEvent           → wire-format dataclass (advanced — usually emitted
                         for you by record_llm_call or the instrumentations)


Migrating from scopecall v0.1.x:

  v0.1 used module-level globals (`scopecall.init(); scopecall.trace(...)`).
  v0.2 returns an instance from `init()`. The two changes most likely to
  break callers:

    OLD:  scopecall.init(api_key="...")               # module-level
          with scopecall.trace(feature="x"):
              ...

    NEW:  sdk = scopecall.init(api_key="...",         # endpoint REQUIRED now
                               endpoint="http://localhost:8080/v1/ingest")
          with sdk.trace("x"):                        # name is positional
              ...

  See CHANGELOG.md → v0.2.0 for the full migration guide.
"""

from ._config import ConfigError, ScopeCallConfig
from ._context import TraceContext
from ._sdk import ScopeCallSDK, init
from ._version import __version__
from .wire._event import LLMEvent

__all__ = [
    "init",
    "ScopeCallSDK",
    "ScopeCallConfig",
    "ConfigError",
    "TraceContext",
    "LLMEvent",
    "__version__",
]
