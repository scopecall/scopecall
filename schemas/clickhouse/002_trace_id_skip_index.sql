-- Skip-index on trace_id so /traces/{span_id} and /traces/tree/{trace_id}
-- (and any future "all spans for trace X" query) don't have to scan every
-- partition for the org.
--
-- Without this, the probe in query/trace_tree.go skips partitions only via
-- the timestamp predicate it
-- DERIVES from the probe — but the probe itself scans all 90 days because
-- trace_id isn't in the primary key (which is org_id, timestamp, span_id).
-- A bloom_filter index lets ClickHouse skip partitions where trace_id is
-- definitely absent.
--
-- Granularity 4 = check every 4 blocks (~32K rows at default); false-positive
-- rate of 1% means ~1% of "absent" blocks get scanned anyway. Good tradeoff:
-- the index is small, the upside is 90 days of partitions → ~12-hour effective
-- scan for a known trace.
--
-- IDEMPOTENT: ALTER TABLE ... ADD INDEX IF NOT EXISTS is safe to re-run.

ALTER TABLE llm_calls
    ADD INDEX IF NOT EXISTS trace_id_bloom (trace_id) TYPE bloom_filter(0.01) GRANULARITY 4;

-- Same treatment for span_id — used by /traces/{span_id} (point lookup). Without
-- a skip index, a span lookup also scans every partition. (T-3 from review.)
ALTER TABLE llm_calls
    ADD INDEX IF NOT EXISTS span_id_bloom (span_id) TYPE bloom_filter(0.001) GRANULARITY 4;

-- Materialize the indices for existing rows. New rows pick them up automatically;
-- MATERIALIZE backfills for data already on disk. Safe on a populated table —
-- runs as a background operation that doesn't block writes.
ALTER TABLE llm_calls MATERIALIZE INDEX trace_id_bloom;
ALTER TABLE llm_calls MATERIALIZE INDEX span_id_bloom;
