package savedviews

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

type View struct {
	ID          string    `json:"id"`
	OrgID       string    `json:"org_id"`
	CreatedBy   string    `json:"created_by,omitempty"`
	Name        string    `json:"name"`
	Path        string    `json:"path"`
	QueryString string    `json:"query_string"`
	Icon        string    `json:"icon,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Create inserts a new view scoped to orgID. Returns the inserted row.
// Names must be unique within an org (DB constraint); the handler maps that
// to a 409 response so users see a useful message.
func (s *Store) Create(ctx context.Context, orgID, createdBy, name, path, queryString, icon string) (*View, error) {
	if name == "" {
		return nil, fmt.Errorf("name required")
	}
	if path == "" {
		return nil, fmt.Errorf("path required")
	}
	if len(name) > 80 {
		return nil, fmt.Errorf("name too long (max 80)")
	}
	// Reject path values that aren't dashboard routes.
	//
	// SECURITY: must catch protocol-relative URLs (`//evil.com`) — they pass a
	// naive `path[0] == '/'` check but are treated by browsers AND Next.js
	// `router.push` as EXTERNAL navigation. Without this guard, an org owner
	// could plant a "Cost dashboard" saved view that off-site-phishes every
	// viewer who clicks it. Also reject `:` to catch `javascript:` / `data:`
	// and friends, and `\` because Edge/IE used to treat `/\evil.com` as
	// protocol-relative. (S-3 from third-pass review.)
	if len(path) < 2 || len(path) > 256 || path[0] != '/' {
		return nil, fmt.Errorf("invalid path")
	}
	if path[1] == '/' || path[1] == '\\' {
		return nil, fmt.Errorf("invalid path (protocol-relative URLs rejected)")
	}
	if strings.ContainsAny(path, ":") {
		return nil, fmt.Errorf("invalid path (colons not allowed)")
	}
	// Cap query_string. Without a cap, a single saved view could store
	// arbitrary megabytes in Postgres TEXT, bloating list responses and
	// inflating org row size. 2KB is comfortable for dashboard URL state
	// (filters + cursor + range) and an order of magnitude under any
	// browser URL limit.
	if len(queryString) > 2048 {
		return nil, fmt.Errorf("query_string too long (max 2048 bytes)")
	}
	var v View
	var createdByDB sql.NullString
	var iconDB sql.NullString
	if createdBy != "" {
		createdByDB = sql.NullString{String: createdBy, Valid: true}
	}
	if icon != "" {
		iconDB = sql.NullString{String: icon, Valid: true}
	}
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO saved_views (org_id, created_by, name, path, query_string, icon)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, org_id, coalesce(created_by, ''), name, path, query_string, coalesce(icon, ''), created_at
	`, orgID, createdByDB, name, path, queryString, iconDB).Scan(
		&v.ID, &v.OrgID, &v.CreatedBy, &v.Name, &v.Path, &v.QueryString, &v.Icon, &v.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert saved view: %w", err)
	}
	return &v, nil
}

func (s *Store) List(ctx context.Context, orgID string) ([]View, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, org_id, coalesce(created_by, ''), name, path, query_string, coalesce(icon, ''), created_at
		FROM saved_views
		WHERE org_id = $1
		ORDER BY created_at DESC
		LIMIT 200
	`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list saved views: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := make([]View, 0, 32)
	for rows.Next() {
		var v View
		if err := rows.Scan(
			&v.ID, &v.OrgID, &v.CreatedBy, &v.Name, &v.Path, &v.QueryString, &v.Icon, &v.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Delete removes a saved view. Only the creator or org owners can delete.
// Without this gate, any viewer in a 20-person org could wipe the owner's
// curated bookmarks (security review concern #7).
//
// requesterUserID: claims.UserID of the caller.
// allowAny: true when the caller has owner role (skip creator check).
func (s *Store) Delete(ctx context.Context, orgID, id, requesterUserID string, allowAny bool) error {
	var res sql.Result
	var err error
	if allowAny {
		res, err = s.db.ExecContext(ctx,
			`DELETE FROM saved_views WHERE id = $1 AND org_id = $2`,
			id, orgID,
		)
	} else {
		// Non-owners can only delete views they created. The created_by NULL
		// case (system-created or pre-migration rows) requires owner role.
		res, err = s.db.ExecContext(ctx,
			`DELETE FROM saved_views WHERE id = $1 AND org_id = $2 AND created_by = $3`,
			id, orgID, requesterUserID,
		)
	}
	if err != nil {
		return fmt.Errorf("delete saved view: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Could be: not found, wrong org, or wrong creator. Return ErrNoRows
		// and let the handler map to 404 — avoids leaking which one it is.
		return sql.ErrNoRows
	}
	return nil
}
