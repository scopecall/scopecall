"""Provider instrumentations.

The public entry point is `sdk.instrument(client, provider=...)` on the
SDK instance — see `scopecall._sdk.ScopeCallSDK.instrument`. The
functions exported here are lower-level escape hatches for callers who
want to wire instrumentation without going through the SDK class
(rare; tests + library-on-library composition).
"""

from ._anthropic import instrument_anthropic
from ._openai import instrument_openai

__all__ = ["instrument_openai", "instrument_anthropic"]
