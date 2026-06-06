-- v0.3 cost-attribution: add customer_id column to llm_calls.
--
-- Why this exists
-- ---------------
-- ScopeCall's existing user_id captures the END-USER (the human chatting
-- with the agent). For B2B applications where one customer organization
-- has many end-users, cost reports group by the CUSTOMER, not the user.
-- Without a separate customer_id, B2B operators can't answer the
-- single most important cost question: "which customer is most
-- expensive to serve?"
--
-- Storage
-- -------
-- Nullable(String) so pre-v0.3 SDKs that don't emit the field continue
-- working — they store NULL on this column. Skip index for fast filter
-- by customer in the typical cost-by-customer query.
--
-- Idempotent — re-running this migration is a no-op.

ALTER TABLE llm_calls
    ADD COLUMN IF NOT EXISTS customer_id Nullable(String) AFTER session_id;

-- Bloom-filter skip index for the cost-by-customer drill-down. The
-- existing trace_id skip index (002) uses GRANULARITY 4 so we match
-- that here — small enough to be useful, large enough to avoid bloating
-- the index size on a high-cardinality column.
ALTER TABLE llm_calls
    ADD INDEX IF NOT EXISTS idx_customer_id customer_id TYPE bloom_filter() GRANULARITY 4;
