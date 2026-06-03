-- Add prompt_version column to llm_calls.
--
-- Powers KPI-attribution use-cases: "we shipped v3 of the customer-support
-- prompt last Tuesday — did p95 latency move? did error rate?". Operators
-- tag the calls via sdk.trace(name, fn, { promptVersion: "v3" }) or via
-- ScopeCallConfig.defaultPromptVersion.
--
-- Column choices
-- - LowCardinality: prompt versions are a small enumerated set per feature
--   (v1, v2, v3, …). Bullseye for LowCardinality's dictionary encoding —
--   most events for one feature collapse to a single dict entry.
-- - Nullable: existing rows have no version, and untagged future calls are
--   fine too. We don't backfill — historical data simply shows
--   prompt_version=NULL in the Prompts breakdown.
--
-- IDEMPOTENT: ALTER TABLE ... ADD COLUMN IF NOT EXISTS is safe to re-run.

ALTER TABLE llm_calls
    ADD COLUMN IF NOT EXISTS prompt_version LowCardinality(Nullable(String));

-- We do NOT add this to the ORDER BY tuple (would require a CREATE/INSERT
-- swap on the production table). The Prompts page filters and groups on
-- prompt_version with org_id + timestamp prefix narrowing — that's fast
-- enough at our scale without changing the primary key.
