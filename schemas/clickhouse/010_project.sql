-- 010: `project` — the application/service dimension, orthogonal to
-- `environment` (the server tier: production/staging/development). One
-- project runs in many environments and one environment hosts many
-- projects. '' = unassigned (events from pre-v0.4 SDKs, which don't send
-- the field); the dashboard renders it as "(unassigned)".
--
-- LowCardinality: project is a label with a handful of distinct values per
-- org, same shape as environment. DEFAULT '' keeps the ALTER metadata-only
-- (no rewrite of existing parts).
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS project LowCardinality(String) DEFAULT '' AFTER environment;
