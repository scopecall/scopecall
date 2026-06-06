package handler

import (
	"context"
	"net/http"
)

// Extra traces filters (provider, user_id, environment, feature_name) aren't
// part of the OpenAPI-generated ListTracesParams. The committed api.gen.go is
// out of sync with what oapi-codegen v2.7.0 now produces (regenerating would
// restructure every endpoint's error responses), so we can't safely add fields
// to gen.ListTracesParams. Instead, the route wrapper stashes these on the
// request context and the strict handler reads them back here.
//
// A typed unexported key avoids any chance of collision with other ctx values.
type traceFilterKey int

const (
	keyProvider traceFilterKey = iota
	keyUserID
	keyEnvironment
	keyFeatureName
	keyQuery
	keyPromptVersion
	// v0.3 — B2B tenant filter. Drilled into from /dashboard/customers and
	// from the workflow-detail page's by-customer breakdown. Distinct from
	// user_id (the end-user of the customer's app).
	keyCustomerID
	// v0.3 — cost-attribution-hierarchy filters. These resolve to trace_id
	// IN-subqueries against the kind='workflow'/'agent'/'step' rows. Used
	// by Waste Inbox drill-ins, Workflow Treemap drill-ins, and the
	// workflow detail page's by-agent / by-step click handlers. Distinct
	// from feature_name — see ListTracesArgs doc-comments.
	keyWorkflow
	keyAgent
	keyStep
)

// WithTraceFilters reads provider/user_id/environment/feature_name from the
// request's query string and returns a context carrying any that are non-empty.
// Call from the route wrapper before invoking the generated strict handler.
func WithTraceFilters(r *http.Request) context.Context {
	ctx := r.Context()
	q := r.URL.Query()
	if v := q.Get("provider"); v != "" {
		ctx = context.WithValue(ctx, keyProvider, v)
	}
	if v := q.Get("user_id"); v != "" {
		ctx = context.WithValue(ctx, keyUserID, v)
	}
	if v := q.Get("environment"); v != "" {
		ctx = context.WithValue(ctx, keyEnvironment, v)
	}
	if v := q.Get("feature_name"); v != "" {
		ctx = context.WithValue(ctx, keyFeatureName, v)
	}
	if v := q.Get("q"); v != "" {
		ctx = context.WithValue(ctx, keyQuery, v)
	}
	if v := q.Get("prompt_version"); v != "" {
		ctx = context.WithValue(ctx, keyPromptVersion, v)
	}
	if v := q.Get("customer_id"); v != "" {
		ctx = context.WithValue(ctx, keyCustomerID, v)
	}
	if v := q.Get("workflow"); v != "" {
		ctx = context.WithValue(ctx, keyWorkflow, v)
	}
	if v := q.Get("agent"); v != "" {
		ctx = context.WithValue(ctx, keyAgent, v)
	}
	if v := q.Get("step"); v != "" {
		ctx = context.WithValue(ctx, keyStep, v)
	}
	return ctx
}

func ctxStr(ctx context.Context, k traceFilterKey) string {
	if v, ok := ctx.Value(k).(string); ok {
		return v
	}
	return ""
}
