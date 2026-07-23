package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/problem"
	"github.com/scopecall/services-go/api/internal/query"
)

// findingJSON is the wire shape of one optimization-gap finding. It's the union
// of the deterministic-rule fields and the prompt-quality (llm_insight) fields;
// the optional scope/prompt fields are omitempty so a rule finding without a
// model/feature doesn't emit empty keys.
type findingJSON struct {
	Category       string  `json:"category"` // caching | tokens | speed | reliability | prompt_quality
	Severity       string  `json:"severity"` // high | medium | low
	Title          string  `json:"title"`
	Detail         string  `json:"detail"`
	Recommendation string  `json:"recommendation"`
	ImpactKind     string  `json:"impact_kind"` // usd | tokens_pct | seconds | calls | none
	ImpactValue    float64 `json:"impact_value"`
	Evidence       string  `json:"evidence"`
	Model          string  `json:"model,omitempty"`
	Feature        string  `json:"feature,omitempty"`
	Source         string  `json:"source"` // rule | llm_insight
	PromptVersion  string  `json:"prompt_version,omitempty"`
}

type recommendationsResponseJSON struct {
	WindowSeconds   int           `json:"window_seconds"`
	TokenWastagePct float64       `json:"token_wastage_pct"`
	Findings        []findingJSON `json:"findings"`
}

// GetRecommendationsHTTP serves GET /api/v1/recommendations — the Optimization
// Gaps feed on Overview. It runs six deterministic analyzers over llm_calls
// (ranked severity-then-impact) and appends any Phase-B prompt-quality audits
// read best-effort from Redis. Same scope/param semantics as /overview.
func (s *Server) GetRecommendationsHTTP(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromCtx(r.Context())
	if claims == nil {
		problem.Write(w, http.StatusUnauthorized, "Unauthorized", "missing authentication")
		return
	}

	q := r.URL.Query()
	if q.Get("org_id") != claims.OrgID {
		problem.Write(w, http.StatusForbidden, "Forbidden", "org_id does not match authenticated organization")
		return
	}

	from, errF := time.Parse(time.RFC3339, q.Get("from"))
	to, errT := time.Parse(time.RFC3339, q.Get("to"))
	if errF != nil || errT != nil {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'from' and 'to' must be absolute ISO8601 timestamps")
		return
	}
	if !to.After(from) {
		problem.Write(w, http.StatusBadRequest, "Bad Request", "'to' must be after 'from'")
		return
	}

	scope := query.Scope{Environment: q.Get("environment"), Project: q.Get("project")}
	result, err := query.Recommendations(r.Context(), s.CH, claims.OrgID, query.TimeWindow{From: from, To: to}, scope)
	if err != nil {
		problem.Write(w, http.StatusInternalServerError, "Internal Server Error", "recommendations query failed")
		return
	}

	// Deterministic rules first (already ranked severity-then-impact by the
	// query layer), then the llm_insight findings from Redis appended after.
	// Redis is best-effort: a nil handle or a read error returns no insights
	// rather than failing the endpoint.
	findings := result.Findings
	findings = append(findings, query.LLMInsightFindings(r.Context(), s.Redis, claims.OrgID, scope)...)

	resp := recommendationsResponseJSON{
		WindowSeconds:   int(to.Sub(from).Seconds()),
		TokenWastagePct: result.TokenWastagePct,
		Findings:        make([]findingJSON, 0, len(findings)),
	}
	for _, f := range findings {
		resp.Findings = append(resp.Findings, findingJSON{
			Category:       f.Category,
			Severity:       f.Severity,
			Title:          f.Title,
			Detail:         f.Detail,
			Recommendation: f.Recommendation,
			ImpactKind:     f.ImpactKind,
			ImpactValue:    f.ImpactValue,
			Evidence:       f.Evidence,
			Model:          f.Model,
			Feature:        f.Feature,
			Source:         f.Source,
			PromptVersion:  f.PromptVersion,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
