package savedviews

import (
	"context"
	"database/sql"
	"fmt"
)

// ApplySchema creates the saved_views table if it doesn't already exist.
// Idempotent so self-hosted instances on every startup get the table without
// needing a separate migration runner. Mirrors the alerts package pattern.
func ApplySchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS saved_views (
    -- gen_random_uuid is built into Postgres 13+ (no pgcrypto extension required).
    -- We prefix for readability when these show up in logs and URLs.
    id              TEXT PRIMARY KEY DEFAULT ('sv_' || replace(gen_random_uuid()::text, '-', '')),
    org_id          TEXT NOT NULL,
    created_by      TEXT,
    name            TEXT NOT NULL,
    -- We store path + query separately so reconstructing the URL is trivial
    -- on the frontend (and so we can dedupe on path for "find views for this page").
    path            TEXT NOT NULL,
    query_string    TEXT NOT NULL DEFAULT '',
    icon            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT saved_views_name_org_unique UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS saved_views_org_idx ON saved_views(org_id, created_at DESC);
`)
	if err != nil {
		return fmt.Errorf("apply saved_views schema: %w", err)
	}
	return nil
}
