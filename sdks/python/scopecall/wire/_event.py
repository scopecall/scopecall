"""LLMEvent — the wire format the SDK ships to the Rust ingest service.

Kept in lockstep with `sdks/typescript/src/wire/llm-event.ts` and the
`llm_calls` ClickHouse table. Adding or renaming a field here MUST be
mirrored in the TS SDK and the Rust ingest's accepted shape on the same
commit, or the wire contract drifts.

Field-by-field history (so the next maintainer knows why each is here):

  Identity (Round-1)        trace_id / span_id / parent_span_id
  Timing  (Round-1)         timestamp (ms epoch), latency_ms, ttft_ms
  Model   (Round-1)         model, provider
  Usage   (Round-1)         input_tokens, output_tokens, cost_usd
  Status  (Round-1)         status, error_message
  Content (Round-2)         input_text, output_text (None vs "" matters —
                            None = SDK didn't capture; "" = empty payload)
  Context (Round-1)         feature_name, user_id, session_id
  Meta    (Round-1)         environment, sdk_version
  Extra   (Round-1)         extra (free-form JSON-stringified blob)
  Streaming (Round-1 P1)    finish_reason, cache_read_tokens
  Cost split (Round-3)      input_cost_usd, output_cost_usd (processor
                            recomputes server-side; SDK values advisory)
  Routing (Round-3)         original_model (gateways that retarget),
                            budget_state, failure_mode
  Tools (Round-3)           tool_calls (JSON-stringified)
  Prompts (Round-4)         prompt_version
  Kind (Round-4)            kind = 'llm' | 'workflow' — workflow spans
                            are synthetic rows emitted by sdk.trace()
                            blocks; they carry zero tokens / zero cost
                            and are filtered out of LLM analytics
                            rollups (see schemas/clickhouse/005_*.sql).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class LLMEvent:
    # ── Identity ─────────────────────────────────────────────────────────
    trace_id: str
    span_id: str
    parent_span_id: str | None

    # ── Timing ───────────────────────────────────────────────────────────
    # `timestamp` is Unix epoch milliseconds (float to match TS Date.now()).
    # `latency_ms` is the full call duration.
    # `ttft_ms` is time-to-first-token, populated only on streaming calls.
    timestamp: float
    latency_ms: int
    ttft_ms: int | None

    # ── Model ────────────────────────────────────────────────────────────
    # `model` is the exact provider ID as called ("gpt-4o", "claude-3-5-sonnet-20241022").
    # `provider` is one of "openai" | "anthropic" | "google" | "unknown" | "" (workflow).
    model: str
    provider: str

    # ── Usage ────────────────────────────────────────────────────────────
    # SDK-supplied cost_usd is ADVISORY. The Rust processor recomputes from
    # the bundled pricing table and overwrites — see services-rust/processor
    # for the canonical values. We still ship a value here so debug/console
    # mode is useful when the processor isn't in the loop.
    input_tokens: int
    output_tokens: int
    cost_usd: float
    # Cost split (Round-3 wire bump). Both Optional because gateways that
    # don't return per-direction usage can't compute them; the processor
    # then fills both from the bundled pricing table.
    input_cost_usd: float | None = None
    output_cost_usd: float | None = None

    # ── Status ───────────────────────────────────────────────────────────
    # "success" | "error" | "timeout" | "rate_limited"
    status: str = "success"
    error_message: str | None = None

    # ── Content ──────────────────────────────────────────────────────────
    # None vs "" matters on the wire. None = capture_content=False or the
    # SDK didn't get the value. "" = the call had an empty payload.
    input_text: str | None = None
    output_text: str | None = None

    # ── Context ──────────────────────────────────────────────────────────
    feature_name: str | None = None
    user_id: str | None = None
    session_id: str | None = None

    # ── Meta ─────────────────────────────────────────────────────────────
    environment: str = "production"
    sdk_version: str = "0.0.0"

    # ── Misc / extensibility ─────────────────────────────────────────────
    # Free-form JSON-stringified blob for instrumentation-specific extras
    # (e.g. Vercel AI SDK system message, framework headers). The Rust
    # ingest stores this verbatim — opaque to the dashboard until a future
    # version surfaces specific keys.
    extra: str | None = None

    # ── Streaming + tool-call detail (Round-1 P1) ───────────────────────
    finish_reason: str | None = None
    cache_read_tokens: int | None = None

    # ── Routing intel (Round-3) ─────────────────────────────────────────
    # When a gateway / fallback re-routes a request to a different model,
    # `model` holds the resolved one and `original_model` holds what the
    # caller asked for. `budget_state` and `failure_mode` are for future
    # budget-enforcement / classification work — kept as wire-stable
    # strings so the SDK can ship them when v0.4 lands without a contract
    # break.
    original_model: str | None = None
    budget_state: str | None = None
    failure_mode: str | None = None
    tool_calls: str | None = None

    # ── Prompt version (Round-4) ────────────────────────────────────────
    # Surfaces in the Prompts page. Per-trace via sdk.trace(prompt_version=...)
    # or globally via init(default_prompt_version=...). Trace value wins;
    # parent trace inherited unless explicitly overridden in a child.
    prompt_version: str | None = None

    # ── Kind (Round-4 P0) ───────────────────────────────────────────────
    # 'llm' for provider calls, 'workflow' for synthetic spans emitted by
    # sdk.trace() blocks. Workflow rows have zero tokens / zero cost and
    # are filtered out of LLM analytics rollups. The Rust ingest validates
    # this field is one of the two values; the ClickHouse rollup MV uses
    # it to gate aggregation.
    kind: Literal["llm", "workflow"] = field(default="llm")

    def to_wire(self) -> dict[str, object]:
        """Serialize to a dict matching the Rust ingest's accepted shape.

        Uses snake_case keys consistent with the rest of the codebase.
        Order is irrelevant on the wire — we keep it stable here for
        diff-friendliness in debug/console mode output.
        """
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id,
            "timestamp": self.timestamp,
            "latency_ms": self.latency_ms,
            "ttft_ms": self.ttft_ms,
            "model": self.model,
            "provider": self.provider,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd,
            "input_cost_usd": self.input_cost_usd,
            "output_cost_usd": self.output_cost_usd,
            "status": self.status,
            "error_message": self.error_message,
            "input_text": self.input_text,
            "output_text": self.output_text,
            "feature_name": self.feature_name,
            "user_id": self.user_id,
            "session_id": self.session_id,
            "environment": self.environment,
            "sdk_version": self.sdk_version,
            "extra": self.extra,
            "finish_reason": self.finish_reason,
            "cache_read_tokens": self.cache_read_tokens,
            "original_model": self.original_model,
            "budget_state": self.budget_state,
            "failure_mode": self.failure_mode,
            "tool_calls": self.tool_calls,
            "prompt_version": self.prompt_version,
            "kind": self.kind,
        }
