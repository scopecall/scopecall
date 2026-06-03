"""Config + validate() — the Round-8 endpoint-required contract.

Every code path here is mirrored in
sdks/typescript/test/init.test.ts; if you change behavior in one,
change it in the other in the same commit.
"""

from __future__ import annotations

import pytest

import scopecall
from scopecall._config import ScopeCallConfig, validate


class TestConfigValidate:
    """validate() encodes the "what counts as a usable config" contract."""

    def test_debug_only_is_valid(self):
        # Console mode — no api_key needed, useful during integration.
        validate(ScopeCallConfig(debug=True))

    def test_output_only_is_valid(self):
        # File mode — no api_key needed, useful for offline batch capture.
        validate(ScopeCallConfig(output="/tmp/x.jsonl"))

    def test_api_key_with_endpoint_is_valid(self):
        validate(
            ScopeCallConfig(
                api_key="sc_test_key",
                endpoint="http://localhost:8080/v1/ingest",
            )
        )

    def test_disabled_short_circuits_validation(self):
        # disabled=True returns a no-op SDK regardless of other fields;
        # we should not refuse to initialize.
        validate(ScopeCallConfig(disabled=True))

    def test_no_transport_at_all_raises(self):
        with pytest.raises(scopecall.ConfigError, match="api_key|debug|output"):
            validate(ScopeCallConfig())

    def test_api_key_without_endpoint_raises(self):
        # Round-8 review: a silent default to hosted Cloud (which doesn't
        # exist yet) would lose every event. Fail loud instead.
        with pytest.raises(scopecall.ConfigError, match="endpoint"):
            validate(ScopeCallConfig(api_key="sc_test_xxx"))


class TestInitFunction:
    """init() is the public entry point — verify both invocation styles."""

    def test_init_via_kwargs(self):
        sdk = scopecall.init(debug=True)
        assert isinstance(sdk, scopecall.ScopeCallSDK)
        assert sdk.config.environment == "production"
        sdk.close(timeout=1.0)

    def test_init_via_config_object(self):
        cfg = ScopeCallConfig(debug=True, environment="staging")
        sdk = scopecall.init(cfg)
        assert sdk.config.environment == "staging"
        sdk.close(timeout=1.0)

    def test_init_rejects_both_config_and_kwargs(self):
        cfg = ScopeCallConfig(debug=True)
        with pytest.raises(TypeError, match="config object and kwargs"):
            scopecall.init(cfg, debug=False)

    def test_init_propagates_config_error(self):
        # Round-8 endpoint-required contract should bubble up through init().
        with pytest.raises(scopecall.ConfigError, match="endpoint"):
            scopecall.init(api_key="sc_test_xxx")

    def test_disabled_sdk_close_is_noop(self):
        sdk = scopecall.init(disabled=True)
        assert sdk.disabled is True
        # Should not raise; should be safely idempotent.
        sdk.close()
        sdk.close()

    def test_flush_interval_clamped_to_positive(self):
        # __post_init__ clamps non-positive intervals — protects the
        # background thread from spinning. The clamp value (0.1) is an
        # implementation detail; the contract is "> 0".
        cfg = ScopeCallConfig(debug=True, flush_interval=0)
        assert cfg.flush_interval > 0
        cfg = ScopeCallConfig(debug=True, flush_interval=-5)
        assert cfg.flush_interval > 0


class TestConfigMode:
    """The mode property selects which transport the exporter uses."""

    def test_disabled_is_noop_mode(self):
        assert ScopeCallConfig(disabled=True, debug=True).mode == "noop"

    def test_debug_is_console_mode(self):
        assert ScopeCallConfig(debug=True).mode == "console"

    def test_output_is_file_mode(self):
        assert ScopeCallConfig(output="/tmp/x.jsonl").mode == "file"

    def test_api_key_is_api_mode(self):
        assert (
            ScopeCallConfig(api_key="k", endpoint="http://x/v1/ingest").mode == "api"
        )

    def test_disabled_wins_over_debug(self):
        # Order of resolution matters — disabled should short-circuit
        # everything else so a test fixture marked disabled never sends
        # anywhere even if other flags happen to be set.
        cfg = ScopeCallConfig(disabled=True, debug=True, output="/tmp/x.jsonl")
        assert cfg.mode == "noop"
