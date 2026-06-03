-- Add `kind` column to llm_calls to distinguish workflow spans (synthetic,
-- emitted by sdk.trace() to give LLM calls a real parent row) from LLM
-- calls (one row per provider invocation).
--
-- Why this exists
-- ---------------
-- Before this column, sdk.trace("agent", async () => { ...llm calls... })
-- set parent_span_id on the LLM-call events to the trace's spanId — but
-- that spanId was never written to ClickHouse. The trace-tree query
--   FROM llm_calls c JOIN llm_calls p ON c.parent_span_id = p.span_id
-- found no parent row, so the workflow node was invisible. Flow Map and
-- trace tree rendered flat. (Round-3 external review P0.)
--
-- With this column, the SDK emits one additional row per sdk.trace() block
-- with kind='workflow', model='', tokens=0, cost=0, and the trace's
-- spanId as span_id. Now the JOIN succeeds and the tree has a real root.
--
-- Column choice
-- -------------
-- LowCardinality(String) — there are only two values ("llm" / "workflow")
-- so dictionary encoding is near-free. Default 'llm' means existing rows
-- (and any payload from pre-v0.1.2 SDKs that don't send the field) are
-- treated as LLM calls without backfill. Future kinds ("tool",
-- "retrieval") would add more values to the dictionary without a schema
-- change.
--
-- IDEMPOTENT: ALTER TABLE … ADD COLUMN IF NOT EXISTS is safe to re-run.

ALTER TABLE llm_calls
    ADD COLUMN IF NOT EXISTS kind LowCardinality(String) DEFAULT 'llm';

-- Skip-index so trace-tree / flow-graph queries that filter on workflow
-- rows (`WHERE kind = 'workflow'`) don't scan the LLM majority of the
-- partition. Granularity 4 = check every 4 granules (~32K rows); the
-- column is two values, set-index will be nearly perfect.
ALTER TABLE llm_calls
    ADD INDEX IF NOT EXISTS kind_set (kind) TYPE set(8) GRANULARITY 4;

ALTER TABLE llm_calls MATERIALIZE INDEX kind_set;
