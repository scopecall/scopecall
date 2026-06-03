package alerts

import (
	"context"
	"database/sql"
	"fmt"
)

// schemaSQL mirrors schemas/postgres/migrations/002_alerts.sql verbatim — kept
// in sync by hand for now. Applied idempotently on every API boot so existing
// installs (where docker-entrypoint-initdb.d already ran) still get the tables.
const schemaSQL = `
CREATE TABLE IF NOT EXISTS alert_rules (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('cost_spike', 'error_rate', 'latency_p99')),
    threshold       DOUBLE PRECISION NOT NULL,
    window_seconds  INTEGER NOT NULL DEFAULT 600 CHECK (window_seconds BETWEEN 60 AND 86400),
    dim_filter      JSONB NOT NULL DEFAULT '{}'::jsonb,
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
    value        DOUBLE PRECISION NOT NULL,
    message      TEXT NOT NULL,
    resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alert_events_rule_open
    ON alert_events(rule_id) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_alert_events_fired
    ON alert_events(fired_at DESC);
`

// ApplySchema idempotently creates the alerts tables. Safe to call on every boot.
func ApplySchema(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("apply alerts schema: %w", err)
	}
	return nil
}
