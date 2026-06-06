-- v0.3 cost-attribution: retry attribution + non-production traffic flag.
--
-- attempt_number (UInt16, DEFAULT 1)
--   1-based caller-attempt index. Increments only when the APPLICATION
--   retries; provider-SDK-internal retries are not counted (they don't
--   add to your bill).
--
-- retry_reason (LowCardinality(Nullable(String)))
--   NULL on the first attempt. Otherwise the closed enum:
--     rate_limit | timeout | server_error | transient_network
--     | agent_decision | manual | unknown
--   The Rust ingest enforces the set so the LowCardinality dictionary
--   stays bounded.
--
-- is_test (Bool, DEFAULT false)
--   True for non-production traffic (eval suites, CI, smoke tests,
--   replays, backfills). The dashboard's "Production only" toggle
--   filters by this column so eval/CI cost doesn't inflate the
--   production cost reports.
--
-- All three columns ship with safe defaults so pre-v0.3 SDKs continue
-- working — their rows store attempt_number=1, retry_reason=NULL,
-- is_test=false, indistinguishable from a normal first-attempt
-- production call.
--
-- Idempotent — re-running this migration is a no-op.

ALTER TABLE llm_calls
    ADD COLUMN IF NOT EXISTS attempt_number UInt16 DEFAULT 1 AFTER customer_id,
    ADD COLUMN IF NOT EXISTS retry_reason LowCardinality(Nullable(String)) AFTER attempt_number,
    ADD COLUMN IF NOT EXISTS is_test Bool DEFAULT false AFTER retry_reason;
