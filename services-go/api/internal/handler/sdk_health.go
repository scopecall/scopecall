package handler

import (
	"encoding/json"
	"net/http"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

// GetSDKHealthHTTP serves GET /api/v1/sdk/health — single-card snapshot of
// how an org's SDK is doing. Wired to the Overview page so a user installing
// the SDK sees their first call arrive in seconds.
func (s *Server) GetSDKHealthHTTP(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}
	if r.URL.Query().Get("org_id") != claims.OrgID {
		problem.Write(w, http.StatusForbidden, "Forbidden", "org_id does not match authenticated organization")
		return
	}
	snap, err := query.SDKHealth(r.Context(), s.CH, claims.OrgID)
	if err != nil {
		// Don't echo the CH error. TODO: structured logging.
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "sdk health query failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(snap)
}
