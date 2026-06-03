package handler

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/redis/go-redis/v9"

	"github.com/scopecall/services-go/api/internal/gen"
	"github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/query"
)

// Server implements gen.StrictServerInterface.
type Server struct {
	CH driver.Conn
}

var _ gen.StrictServerInterface = (*Server)(nil)

func (s *Server) GetOverview(ctx context.Context, req gen.GetOverviewRequestObject) (gen.GetOverviewResponseObject, error) {
	claims := middleware.ClaimsFromCtx(ctx)
	if req.Params.OrgId != claims.OrgID {
		return gen.GetOverview403ApplicationProblemPlusJSONResponse(probProblem(http.StatusForbidden, "Forbidden", "org_id does not match authenticated organization")), nil
	}
	if !req.Params.To.After(req.Params.From) {
		return gen.GetOverview400ApplicationProblemPlusJSONResponse{ProblemApplicationProblemPlusJSONResponse: probResponse(http.StatusBadRequest, "Bad Request", "'to' must be after 'from'")}, nil
	}

	tw := query.TimeWindow{From: req.Params.From, To: req.Params.To}
	res, err := query.Overview(ctx, s.CH, claims.OrgID, tw)
	if err != nil {
		return nil, err
	}
	return gen.GetOverview200JSONResponse{
		TotalCalls:   int(res.TotalCalls),
		TotalCostUsd: res.TotalCostUSD,
		AvgLatencyMs: res.AvgLatencyMS,
		P99LatencyMs: res.P99LatencyMS,
		ErrorRatePct: res.ErrorRatePct,
		UniqueTraces: int(res.UniqueTraces),
	}, nil
}

func (s *Server) ListTraces(ctx context.Context, req gen.ListTracesRequestObject) (gen.ListTracesResponseObject, error) {
	claims := middleware.ClaimsFromCtx(ctx)
	if req.Params.OrgId != claims.OrgID {
		return gen.ListTraces403ApplicationProblemPlusJSONResponse(probProblem(http.StatusForbidden, "Forbidden", "org_id does not match authenticated organization")), nil
	}
	if !req.Params.To.After(req.Params.From) {
		return gen.ListTraces400ApplicationProblemPlusJSONResponse{ProblemApplicationProblemPlusJSONResponse: probResponse(http.StatusBadRequest, "Bad Request", "'to' must be after 'from'")}, nil
	}

	limit := 100
	if req.Params.Limit != nil {
		limit = *req.Params.Limit
	}
	cursor := ""
	if req.Params.Cursor != nil {
		cursor = *req.Params.Cursor
	}

	args := query.ListTracesArgs{
		OrgID:   claims.OrgID,
		Window:  query.TimeWindow{From: req.Params.From, To: req.Params.To},
		IsOwner: claims.PrincipalClass == "owner",
		Cursor:  cursor,
		Limit:   limit,
	}
	if req.Params.Model != nil {
		args.Model = string(*req.Params.Model)
	}
	// Status was previously extracted into req.Params but never propagated to
	// the query — the Status dropdown in the UI silently did nothing. Fixed.
	if req.Params.Status != nil {
		args.Status = string(*req.Params.Status)
	}
	// Extras that aren't in the generated ListTracesParams come in via the
	// request context (set by WithTraceFilters in the route wrapper).
	args.Provider = ctxStr(ctx, keyProvider)
	args.UserID = ctxStr(ctx, keyUserID)
	args.Environment = ctxStr(ctx, keyEnvironment)
	args.FeatureName = ctxStr(ctx, keyFeatureName)
	args.Query = ctxStr(ctx, keyQuery)
	args.PromptVersion = ctxStr(ctx, keyPromptVersion)

	res, err := query.ListTraces(ctx, s.CH, args)
	if err != nil {
		return nil, err
	}

	traces := make([]gen.Trace, 0, len(res.Traces))
	for _, t := range res.Traces {
		traces = append(traces, traceToGen(t))
	}
	resp := gen.ListTraces200JSONResponse{Traces: traces}
	if res.NextCursor != "" {
		resp.NextCursor = &res.NextCursor
	}
	return resp, nil
}

func (s *Server) GetTrace(ctx context.Context, req gen.GetTraceRequestObject) (gen.GetTraceResponseObject, error) {
	claims := middleware.ClaimsFromCtx(ctx)
	if req.Params.OrgId != claims.OrgID {
		// 404 not 403 — avoids org enumeration
		return gen.GetTrace404ApplicationProblemPlusJSONResponse(probProblem(http.StatusNotFound, "Not Found", "trace not found")), nil
	}

	t, err := query.GetTrace(ctx, s.CH, claims.OrgID, req.SpanId, claims.PrincipalClass == "owner")
	if err != nil {
		return nil, err
	}
	if t == nil {
		return gen.GetTrace404ApplicationProblemPlusJSONResponse(probProblem(http.StatusNotFound, "Not Found", "trace not found")), nil
	}
	return gen.GetTrace200JSONResponse(traceToGen(*t)), nil
}

func (s *Server) GetCostMetrics(ctx context.Context, req gen.GetCostMetricsRequestObject) (gen.GetCostMetricsResponseObject, error) {
	claims := middleware.ClaimsFromCtx(ctx)
	if req.Params.OrgId != claims.OrgID {
		return gen.GetCostMetrics400ApplicationProblemPlusJSONResponse{ProblemApplicationProblemPlusJSONResponse: probResponse(http.StatusBadRequest, "Bad Request", "org_id does not match authenticated organization")}, nil
	}
	pts, err := query.Metrics(ctx, s.CH, claims.OrgID, query.TimeWindow{From: req.Params.From, To: req.Params.To}, granularityStr(req.Params.Granularity))
	if err != nil {
		return nil, err
	}
	return gen.GetCostMetrics200JSONResponse{Points: toMetricPoints(pts)}, nil
}

func (s *Server) GetLatencyMetrics(ctx context.Context, req gen.GetLatencyMetricsRequestObject) (gen.GetLatencyMetricsResponseObject, error) {
	claims := middleware.ClaimsFromCtx(ctx)
	if req.Params.OrgId != claims.OrgID {
		return gen.GetLatencyMetrics400ApplicationProblemPlusJSONResponse{ProblemApplicationProblemPlusJSONResponse: probResponse(http.StatusBadRequest, "Bad Request", "org_id does not match authenticated organization")}, nil
	}
	pts, err := query.Metrics(ctx, s.CH, claims.OrgID, query.TimeWindow{From: req.Params.From, To: req.Params.To}, granularityStr(req.Params.Granularity))
	if err != nil {
		return nil, err
	}
	return gen.GetLatencyMetrics200JSONResponse{Points: toMetricPoints(pts)}, nil
}

func (s *Server) GetErrorMetrics(ctx context.Context, req gen.GetErrorMetricsRequestObject) (gen.GetErrorMetricsResponseObject, error) {
	claims := middleware.ClaimsFromCtx(ctx)
	if req.Params.OrgId != claims.OrgID {
		return gen.GetErrorMetrics400ApplicationProblemPlusJSONResponse{ProblemApplicationProblemPlusJSONResponse: probResponse(http.StatusBadRequest, "Bad Request", "org_id does not match authenticated organization")}, nil
	}
	pts, err := query.Metrics(ctx, s.CH, claims.OrgID, query.TimeWindow{From: req.Params.From, To: req.Params.To}, granularityStr(req.Params.Granularity))
	if err != nil {
		return nil, err
	}
	return gen.GetErrorMetrics200JSONResponse{Points: toMetricPoints(pts)}, nil
}

// granularityStr unwraps gen.*ParamsGranularity (pointer to enum) into a plain
// lowercase string. All three metrics handlers have identically-shaped granularity
// params under different generated type names, but the underlying string is the
// same: "hour" or "day". Defaults to "hour" when nil.
func granularityStr[T ~string](g *T) string {
	if g == nil {
		return "hour"
	}
	return string(*g)
}

func (s *Server) ListAlerts(_ context.Context, _ gen.ListAlertsRequestObject) (gen.ListAlertsResponseObject, error) {
	msg := "anomaly detection is not yet implemented"
	return gen.ListAlerts200JSONResponse{
		Alerts:  []interface{}{},
		Message: msg,
	}, nil
}

// HealthHandler checks all three data dependencies.
//
// Contract: GET /health
//
//	200 + {"status":"ok",       ...} — every dependency healthy.
//	503 + {"status":"degraded", ...} — one or more dependencies failed Ping.
//	                                   k8s readiness probes will pull the pod
//	                                   out of rotation; load balancers will
//	                                   route around it. This matters: without
//	                                   the 503, a pod with both DBs down stays
//	                                   in the LB pool and 500s every request.
//	                                   (S-2 from third-pass review.)
//
// ClickHouse + Postgres count as "critical" — either down → 503. Redis is a
// cache; degraded Redis means slower queries but not broken, so it doesn't
// flip the status code (just exposed in the body for operator awareness).
func HealthHandler(ch driver.Conn, sqlDB *sql.DB, rdb *redis.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		chStatus := "ok"
		if err := ch.Ping(r.Context()); err != nil {
			chStatus = "degraded"
		}

		pgStatus := "ok"
		if err := sqlDB.PingContext(r.Context()); err != nil {
			pgStatus = "degraded"
		}

		redisStatus := "ok"
		if err := rdb.Ping(r.Context()).Err(); err != nil {
			redisStatus = "degraded"
		}

		// Either critical dep degraded → overall degraded → 503 status code.
		overallStatus := "ok"
		httpStatus := http.StatusOK
		if chStatus != "ok" || pgStatus != "ok" {
			overallStatus = "degraded"
			httpStatus = http.StatusServiceUnavailable
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(httpStatus)
		fmt.Fprintf(w, `{"status":%q,"clickhouse":%q,"postgres":%q,"redis":%q}`, //nolint:errcheck
			overallStatus, chStatus, pgStatus, redisStatus)
	}
}

// -- helpers --

// probResponse builds the embedded type used by 400 responses.
func probResponse(status int, title, detail string) gen.ProblemApplicationProblemPlusJSONResponse {
	return gen.ProblemApplicationProblemPlusJSONResponse{
		Type:   "about:blank",
		Title:  title,
		Status: status,
		Detail: detail,
	}
}

// probProblem builds the Problem type used by 401/403/404 responses (type aliases, not embedded structs).
func probProblem(status int, title, detail string) gen.Problem {
	return gen.Problem{Type: "about:blank", Title: title, Status: status, Detail: detail}
}

func traceToGen(t query.TraceRow) gen.Trace {
	inputText := t.InputText
	outputText := t.OutputText
	sdkVersion := t.SDKVersion
	// Take addresses for the pointer fields on gen.Trace. omitempty on
	// the JSON tag would suppress these if we passed pointer-to-zero,
	// but we want them present in the response so the dashboard's cost
	// breakdown UI knows the server has authoritative numbers. The
	// component costs are stored as DEFAULT 0 in CH; a real $0 call and
	// "we don't know" are distinguishable only by the prompt-version /
	// cost-source convention, so we always surface the stored value.
	inputCost := t.InputCostUSD
	outputCost := t.OutputCostUSD
	kind := t.Kind
	return gen.Trace{
		OrgId:         t.OrgID,
		TraceId:       t.TraceID,
		SpanId:        t.SpanID,
		ParentSpanId:  t.ParentSpanID,
		Timestamp:     t.Timestamp.UTC(),
		Model:         t.Model,
		Provider:      t.Provider,
		InputTokens:   int(t.InputTokens),
		OutputTokens:  int(t.OutputTokens),
		CostUsd:       t.CostUSD,
		InputCostUsd:  &inputCost,
		OutputCostUsd: &outputCost,
		LatencyMs:     int(t.LatencyMS),
		TtftMs:        uintPtrToIntPtr(t.TTFTMS),
		Status:        t.Status,
		ErrorMessage:  t.ErrorMessage,
		InputText:     &inputText,
		OutputText:    &outputText,
		FeatureName:   t.FeatureName,
		UserId:        t.UserID,
		SessionId:     t.SessionID,
		Environment:   t.Environment,
		SdkVersion:    &sdkVersion,
		Extra:         t.Extra,
		PromptVersion: t.PromptVersion,
		Kind:          &kind,
	}
}

func uintPtrToIntPtr(u *uint32) *int {
	if u == nil {
		return nil
	}
	v := int(*u)
	return &v
}

func toMetricPoints(pts []query.MetricPoint) []gen.MetricPoint {
	out := make([]gen.MetricPoint, 0, len(pts))
	for _, p := range pts {
		model := p.Model
		callCount := int(p.CallCount)
		cost := p.TotalCostUSD
		avg := p.AvgLatencyMS
		p99 := p.P99LatencyMS
		errCount := int(p.ErrorCount)
		out = append(out, gen.MetricPoint{
			Timestamp:    p.Hour.UTC(),
			Model:        &model,
			CallCount:    &callCount,
			TotalCostUsd: &cost,
			AvgLatencyMs: &avg,
			P99LatencyMs: &p99,
			ErrorCount:   &errCount,
		})
	}
	return out
}
