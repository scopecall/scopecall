package handler

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/scopecall/services-go/common/auth"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/savedviews"
)

// SavedViewsServer exposes CRUD for org-scoped saved views (URL bookmarks).
// Holds its own *savedviews.Store rather than sharing one — matches the
// AlertsServer pattern for cleanly testable concerns.
type SavedViewsServer struct {
	Store *savedviews.Store
}

// ListSavedViews — GET /api/v1/views
func (s *SavedViewsServer) ListSavedViews(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	views, err := s.Store.List(r.Context(), claims.OrgID)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "list views failed")
		return
	}
	writeJSON(w, map[string]any{"views": views})
}

// requireUserSession rejects auth paths that don't carry a real user
// identity. Today that means API-key Bearer auth: resolveAPIKey returns
// {OrgID, PrincipalClass: "viewer"} with an empty UserID, while the
// trusted-proxy and JWT paths both set a non-empty UserID. Endpoints
// that write user-attributed resources (saved_views.created_by) call
// this so an `ingest:write` + `traces:read` API key can't impersonate
// an org-wide service account and pollute another tenant's UX surface.
//
// Round-10 review: a `traces:read` key being able to POST/DELETE saved
// views contradicted the scope's "read access" promise. Empty-UserID
// is the simplest correct signal until we promote API-key auth to
// its own PrincipalClass ("service") — that refactor is on the
// Cloud-readiness list, not a launch blocker.
func requireUserSession(w http.ResponseWriter, claims *auth.Claims) bool {
	if claims.UserID == "" {
		problem.Write(w, http.StatusForbidden, "Forbidden",
			"this endpoint requires a logged-in user session; API keys cannot create user-scoped resources")
		return false
	}
	return true
}

// CreateSavedView — POST /api/v1/views
// Body: { name: string, path: string, query_string?: string, icon?: string }
func (s *SavedViewsServer) CreateSavedView(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	if !requireUserSession(w, claims) {
		return
	}
	// Bound peak decoder memory. The 30s server timeout handles slow-body;
	// this cap stops a single oversized POST from inflating the decode buffer.
	// 8KB is plenty for name + path + 2KB query_string.
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var body struct {
		Name        string `json:"name"`
		Path        string `json:"path"`
		QueryString string `json:"query_string"`
		Icon        string `json:"icon"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "invalid JSON")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Path = strings.TrimSpace(body.Path)
	body.QueryString = strings.TrimPrefix(body.QueryString, "?") // accept both forms

	view, err := s.Store.Create(r.Context(), claims.OrgID, claims.UserID, body.Name, body.Path, body.QueryString, body.Icon)
	if err != nil {
		// Postgres UNIQUE violations come back as opaque errors; sniff for the
		// constraint name so the user sees a useful message.
		if strings.Contains(err.Error(), "saved_views_name_org_unique") {
			problem.Write(w, http.StatusConflict, "Conflict", "a view with that name already exists in this org")
			return
		}
		// Don't echo raw Postgres errors — schema/constraint names leak.
		// The store returns sentinel validation messages for known input
		// problems (length, invalid path, protocol-relative URL); generic
		// 400 message is enough for everything else. (S-5 from review.)
		problem.Write(w, http.StatusBadRequest, "Bad Request", "view creation failed (check name, path, and query string)")
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, view)
}

// DeleteSavedView — DELETE /api/v1/views/{id}
func (s *SavedViewsServer) DeleteSavedView(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	if !requireUserSession(w, claims) {
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "missing id")
		return
	}
	// Owners can delete any view in their org; everyone else only their own.
	allowAny := claims.PrincipalClass == "owner"
	if err := s.Store.Delete(r.Context(), claims.OrgID, id, claims.UserID, allowAny); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			problem.Write(w, http.StatusNotFound, "Not Found", "view not found")
			return
		}
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
