"""Shared pytest fixtures.

Every test that creates an SDK uses `make_sdk` so we don't sprinkle
endpoint/api_key boilerplate everywhere, and so we have a single place
to inject a deterministic test transport when chunk 2's instrumentation
tests need it.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

import scopecall


@pytest.fixture
def make_sdk():
    """Factory that creates an SDK with sensible test defaults.

    Defaults to `debug=True` (console transport) so no network IO unless
    the test explicitly overrides. Closes the SDK on test teardown so
    background flush threads don't leak between tests.
    """
    created: list[scopecall.ScopeCallSDK] = []

    def _make(**overrides) -> scopecall.ScopeCallSDK:
        defaults = {"debug": True, "environment": "test"}
        defaults.update(overrides)
        sdk = scopecall.init(**defaults)
        created.append(sdk)
        return sdk

    yield _make

    for sdk in created:
        sdk.close(timeout=2.0)
