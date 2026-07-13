package handler

import (
	"encoding/json"
	"net/http"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

type projectsResponseJSON struct {
	Projects []string `json:"projects"`
}

// GetProjectsHTTP serves GET /api/v1/projects — the org's distinct project
// labels, feeding the dashboard's project picker. Not windowed (see
// query.Projects for the rationale).
func (s *Server) GetProjectsHTTP(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	if r.URL.Query().Get("org_id") != claims.OrgID {
		problem.Write(w, http.StatusForbidden, "Forbidden", "org_id does not match authenticated organization")
		return
	}

	projects, err := query.Projects(r.Context(), s.CH, claims.OrgID)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "projects query failed")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(projectsResponseJSON{Projects: projects})
}
