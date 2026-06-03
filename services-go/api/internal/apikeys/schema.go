// Package apikeys hosts the schema patch the dashboard's key management
// UI needs.
//
// The api_keys table itself is created by self-hosted's postgres-init.sql
// (first-boot) or by the 001_initial.sql migration. This package adds the
// two columns the management UI introduced — key_prefix and last_used_at —
// on every API boot, so existing installs upgrade automatically without a
// manual migration step.
//
// Same idempotent-on-boot pattern as savedviews + alerts. Cheap (two
// ALTER ... IF NOT EXISTS), runs once per process start, and avoids the
// "user upgraded but the new column is missing" failure mode.
package apikeys

import (
	"context"
	"database/sql"
	"fmt"
)

// ApplySchema is safe to call repeatedly. ALTER ADD COLUMN IF NOT EXISTS is
// a Postgres 9.6+ feature; CREATE INDEX IF NOT EXISTS is older.
//
// scopes is added as nullable on purpose: NULL means "legacy key, all
// scopes allowed" — that's the back-compat path for keys minted before
// the column existed. New keys minted via the dashboard always pass an
// explicit scope set (default ['ingest:write']).
func ApplySchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix   TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes       TEXT[];
-- revoked_at backs the dashboard auto-delete countdown and the periodic
-- cleanup goroutine. NULL on legacy revoked rows is intentional: the
-- cleanup filters revoked_at IS NOT NULL so we never garbage-collect a
-- row whose revocation timestamp we do not know.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_api_keys_org_created_at
  ON api_keys (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_keys_scopes
  ON api_keys USING GIN (scopes);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at
  ON api_keys (revoked_at)
  WHERE revoked = TRUE AND revoked_at IS NOT NULL;
`)
	if err != nil {
		return fmt.Errorf("apply api_keys schema: %w", err)
	}
	return nil
}
