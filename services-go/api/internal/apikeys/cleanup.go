package apikeys

import (
	"context"
	"database/sql"
	"time"

	"go.uber.org/zap"

	"github.com/scopecall/services-go/api/internal/db"
)

// Default retention. Overridable via API_KEY_RETENTION_DAYS env var read in
// cmd/api/main.go. The default leans on the safer side of the trade-off:
// short enough to keep the audit list bounded, long enough that a leak
// surfacing two-to-three weeks after rotation still finds the row.
const DefaultRetentionDays = 30

// Period at which the cleanup loop runs. Hourly is plenty — the cleanup
// is a small DELETE on a partial index; running more often wouldn't catch
// anything sooner than the retention window itself.
const cleanupInterval = time.Hour

// CleanupJob deletes revoked api_keys rows whose revoked_at is older than
// the configured retention window. Mirrors the pattern of the alerts
// evaluator goroutine (long-lived background loop tied to the API
// process's lifetime).
//
// Why a goroutine and not pg_cron / external cron:
//   - pg_cron requires a Postgres extension that managed providers
//     (Neon, RDS sometimes) don't always permit.
//   - External cron adds operational surface (one more thing to monitor)
//     and forces fresh-install users to learn a separate concept.
//   - The Go API process already runs forever and has a healthcheck. A
//     goroutine that ticks once an hour is the smallest correct
//     dependency-free shape.
type CleanupJob struct {
	Queries       *db.Queries
	RetentionDays int
	Log           *zap.Logger
}

// Run blocks on the provided context. The intended caller is `go
// cleanup.Run(ctx)` from main; the loop exits cleanly when ctx is
// cancelled (rare today — main uses context.Background — but the shape
// is right for future graceful-shutdown work).
func (c *CleanupJob) Run(ctx context.Context) {
	retention := c.RetentionDays
	if retention <= 0 {
		retention = DefaultRetentionDays
	}
	c.Log.Info("api-key cleanup started",
		zap.Int("retention_days", retention),
		zap.Duration("interval", cleanupInterval),
	)

	// Tick once at startup so a misconfigured retention shows up in logs
	// immediately rather than after the first hour.
	c.runOnce(ctx, retention)

	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			c.Log.Info("api-key cleanup stopped")
			return
		case <-ticker.C:
			c.runOnce(ctx, retention)
		}
	}
}

// runOnce executes the DELETE and logs the row count. Errors are logged
// but never propagated — a failed cleanup is a transient operational
// concern, not a request-path failure, and the next tick will retry.
func (c *CleanupJob) runOnce(ctx context.Context, retentionDays int) {
	cutoff := time.Now().Add(-time.Duration(retentionDays) * 24 * time.Hour)
	rows, err := c.Queries.DeleteOldRevokedAPIKeys(
		ctx,
		sql.NullTime{Time: cutoff, Valid: true},
	)
	if err != nil {
		c.Log.Warn("api-key cleanup failed", zap.Error(err))
		return
	}
	if rows > 0 {
		c.Log.Info("api-key cleanup deleted revoked keys",
			zap.Int64("rows", rows),
			zap.Time("cutoff", cutoff),
		)
	}
}
