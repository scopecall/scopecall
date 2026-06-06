-- v0.3 cost-attribution: server-derived cost metadata.
--
-- cache_read_cost_usd (Float64, DEFAULT 0)
--   Cost of the cached portion of input tokens. Anthropic charges ~10%
--   of input rate for cache reads; OpenAI charges ~50%. Computed by the
--   processor when the model's pricing entry has a cache_read rate
--   (currently absent — defaults to 0 until cache rates land in
--   pricing.json for the v0.3 dashboard release).
--
-- cost_source (LowCardinality(String), DEFAULT 'unknown_model')
--   Trust signal for cost_usd. Closed enum:
--     server_computed - reprice() set cost from the pricing table
--     sdk_fallback    - model unknown to pricing table; kept SDK cost
--     unknown_model   - model unknown AND SDK cost was 0
--   Lets the dashboard show a confidence indicator next to costs.
--
-- pricing_version (LowCardinality(Nullable(String)))
--   Pricing-table version (YYYY-MM-DD verification date) that produced
--   cost_usd. Stamped by the processor; makes historical re-pricing
--   auditable. NULL on rows the processor didn't reprice — specifically
--   container spans (workflow / agent / step) where there's no model
--   to version.
--
-- All three columns are server-derived. SDKs never set them. Backward
-- compatibility: pre-v0.3 historical rows hit the column defaults
-- (cache_read_cost_usd=0, cost_source='unknown_model', pricing_version=NULL)
-- which is the correct treatment — old rows lack the metadata to do
-- better.
--
-- Idempotent — re-running this migration is a no-op.

ALTER TABLE llm_calls
    ADD COLUMN IF NOT EXISTS cache_read_cost_usd Float64 DEFAULT 0 AFTER output_cost_usd,
    ADD COLUMN IF NOT EXISTS cost_source LowCardinality(String) DEFAULT 'unknown_model' AFTER cache_read_cost_usd,
    ADD COLUMN IF NOT EXISTS pricing_version LowCardinality(Nullable(String)) AFTER cost_source;
