"""Framework integrations for ScopeCall.

ScopeCall's core is framework-agnostic: a workflow / agent / step / llm
span hierarchy with thread-safe context propagation. These adapters teach
ScopeCall to derive that hierarchy *automatically* from popular agent
frameworks, so an app gets full orchestration visibility (and flow-level
cost attribution) without hand-instrumenting every node.

Each adapter is thin and built on the same primitives in ``_base``:

    scopecall.integrations.langgraph.instrument()   # auto-agent per node
    scopecall.integrations.langchain.ScopeCallHandler()   # (planned)
    scopecall.integrations.crewai.instrument()            # (planned)

The shared contract every adapter upholds:
  * No-op when ScopeCall is uninitialized (``get_active()`` is None).
  * Never raises into the host framework.
  * Idempotent — instrumenting twice is safe.
"""

from . import _base

__all__ = ["_base"]
