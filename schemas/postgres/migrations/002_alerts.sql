-- Alerts: rule storage + event history.
-- Applied idempotently by the API at startup (see internal/alerts/schema.go).

CREATE TABLE IF NOT EXISTS alert_rules (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    -- One of: cost_spike, error_rate, latency_p99
    type            TEXT NOT NULL CHECK (type IN ('cost_spike', 'error_rate', 'latency_p99')),
    threshold       DOUBLE PRECISION NOT NULL,
    window_seconds  INTEGER NOT NULL DEFAULT 600 CHECK (window_seconds BETWEEN 60 AND 86400),
    -- JSON map of dim → value, e.g. {"environment": "prod", "model": "gpt-4o"}
    dim_filter      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- 'slack' = post to channel_config.webhook_url; 'none' = store-only, no push
    channel_type    TEXT NOT NULL DEFAULT 'none' CHECK (channel_type IN ('slack', 'none')),
    channel_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_org_enabled
    ON alert_rules(org_id, enabled);

CREATE TABLE IF NOT EXISTS alert_events (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    rule_id      TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    fired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The metric value at the moment the rule crossed threshold
    value        DOUBLE PRECISION NOT NULL,
    message      TEXT NOT NULL,
    -- NULL while the alert is open; set when subsequent evaluation drops below threshold
    resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alert_events_rule_open
    ON alert_events(rule_id) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_alert_events_fired
    ON alert_events(fired_at DESC);
