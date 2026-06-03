package main

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
	_ "github.com/jackc/pgx/v5/stdlib" // register "pgx" driver for database/sql
	"go.uber.org/zap"

	"github.com/scopecall/services-go/common/auth"
	"github.com/scopecall/services-go/common/cache"
	chchclient "github.com/scopecall/services-go/common/clickhouse"

	"github.com/scopecall/services-go/api/internal/alerts"
	"github.com/scopecall/services-go/api/internal/apikeys"
	"github.com/scopecall/services-go/api/internal/db"
	"github.com/scopecall/services-go/api/internal/gen"
	"github.com/scopecall/services-go/api/internal/handler"
	apimw "github.com/scopecall/services-go/api/internal/middleware"
	"github.com/scopecall/services-go/api/internal/savedviews"

	"database/sql"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync() //nolint:errcheck

	port := envOr("API_PORT", "3004")
	chHost := envOr("CLICKHOUSE_HOST", "localhost")
	chPortStr := envOr("CLICKHOUSE_PORT", "9000")
	chDB := envOr("CLICKHOUSE_DATABASE", "default")
	chUser := envOr("CLICKHOUSE_USER", "default")
	chPass := envOr("CLICKHOUSE_PASSWORD", "")
	pgDSN := envOr("DATABASE_URL", "postgres://scopecall:scopecall@localhost:5432/scopecall")
	redisAddr := envOr("REDIS_URL", "localhost:6379")
	jwksURL := envOr("JWKS_URL", "")
	internalAPIKey := envOr("INTERNAL_API_KEY", "")
	corsOrigins := strings.Split(envOr("CORS_ORIGINS", "http://localhost:3000"), ",")
	corsRegex := apimw.CompileCORSRegex(envOr("CORS_ORIGIN_REGEX", ""))

	// ── ClickHouse ─────────────────────────────────────────────────────────
	chPort, _ := strconv.Atoi(chPortStr)
	ch, err := chchclient.New(chchclient.Config{
		Host: chHost, Port: chPort,
		Database: chDB, Username: chUser, Password: chPass,
	})
	if err != nil {
		log.Fatal("clickhouse connect", zap.Error(err))
	}

	// ── Postgres (sqlc) — pgx stdlib driver ───────────────────────────────
	sqlDB, err := sql.Open("pgx", pgDSN)
	if err != nil {
		log.Fatal("postgres open", zap.Error(err))
	}
	defer sqlDB.Close() //nolint:errcheck
	// Pool sizing — applied BEFORE Ping so the bootstrap conn comes from the
	// configured pool rather than the unbounded default. database/sql
	// defaults to UNLIMITED open conns, which can trip managed-PG
	// max_connections (Neon default 100; RDS varies) under even modest
	// spikes. 25 covers our concurrent load (alerts evaluator + saved-views
	// + auth lookups + handler-level queries) with significant headroom;
	// 30-min lifetime plays nice with PgBouncer / Neon idle culling.
	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(30 * time.Minute)
	if err := sqlDB.PingContext(context.Background()); err != nil {
		log.Fatal("postgres ping", zap.Error(err))
	}
	queries := db.New(sqlDB)

	// ── Redis ──────────────────────────────────────────────────────────────
	rdb := cache.New(redisAddr)
	if err := cache.Ping(context.Background(), rdb); err != nil {
		log.Warn("redis unavailable — auth falls back to Postgres", zap.Error(err))
	}

	// ── JWKS cache ─────────────────────────────────────────────────────────
	jwksCache := auth.NewJWKSCache(jwksURL)

	// ── Alerts: apply schema, build store, start evaluator goroutine ───────
	if err := alerts.ApplySchema(context.Background(), sqlDB); err != nil {
		log.Fatal("alerts schema apply failed", zap.Error(err))
	}
	alertStore := alerts.NewStore(sqlDB)
	alertsHandler := &handler.AlertsServer{Store: alertStore, CH: ch}

	// ── API keys: apply schema patch + start cleanup goroutine ────────────
	// Adds key_prefix + last_used_at + scopes + revoked_at columns to
	// existing api_keys tables. Self-hosted installs upgraded from an
	// older build pick these up on the next API boot — no manual
	// migration required.
	if err := apikeys.ApplySchema(context.Background(), sqlDB); err != nil {
		log.Fatal("api_keys schema patch failed", zap.Error(err))
	}
	// API_KEY_RETENTION_DAYS controls how long revoked keys linger before
	// being permanently deleted. Default 30. Set to a higher number for
	// stricter audit retention; 0 / unset falls through to DefaultRetentionDays.
	retentionDays := apikeys.DefaultRetentionDays
	if v := os.Getenv("API_KEY_RETENTION_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			retentionDays = n
		} else {
			log.Warn("API_KEY_RETENTION_DAYS invalid, falling back to default",
				zap.String("got", v),
				zap.Int("default", apikeys.DefaultRetentionDays))
		}
	}
	cleanup := &apikeys.CleanupJob{
		Queries:       queries,
		RetentionDays: retentionDays,
		Log:           log,
	}
	go cleanup.Run(context.Background())

	// ── Saved views: apply schema, build store + handler ───────────────────
	if err := savedviews.ApplySchema(context.Background(), sqlDB); err != nil {
		log.Fatal("saved_views schema apply failed", zap.Error(err))
	}
	savedViewsHandler := &handler.SavedViewsServer{Store: savedviews.NewStore(sqlDB)}
	// Background evaluation; goroutine outlives request lifecycles but stops
	// when the process does (context.Background is fine for v1 — graceful
	// shutdown is a follow-up).
	go alerts.NewEvaluator(alertStore, ch, log).Run(context.Background(), 60*time.Second)

	// ── Strict handler (implements StrictServerInterface) ──────────────────
	srv := &handler.Server{CH: ch}
	strictHandler := gen.NewStrictHandler(srv, nil)

	// ── Router ─────────────────────────────────────────────────────────────
	r := chi.NewRouter()
	r.Use(apimw.CORS(corsOrigins, corsRegex)) // must be first — applies to OPTIONS preflight
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))
	// Coarse IP-based limit to guard /health and unauthenticated paths from floods.
	// Fine-grained per-org limit is applied inside the auth group below (after claims exist).
	r.Use(httprate.LimitByIP(200, time.Minute))

	r.Get("/health", handler.HealthHandler(ch, sqlDB, rdb))

	authCfg := apimw.AuthConfig{
		JWKSCache:      jwksCache,
		Redis:          rdb,
		Queries:        queries,
		Log:            log,
		InternalAPIKey: internalAPIKey,
	}

	cacheTTLs := map[string]time.Duration{
		"overview":        30 * time.Second,
		"traces":          60 * time.Second,
		"trace_detail":    5 * time.Minute,
		"metrics_cost":    2 * time.Minute,
		"metrics_latency": 2 * time.Minute,
		"metrics_errors":  2 * time.Minute,
		"alerts":          30 * time.Second,
		"breakdown":         60 * time.Second,
		"trace_tree":        5 * time.Minute,
		"top_movers":        2 * time.Minute,
		"errors_by_status":  60 * time.Second,
		"sessions":          60 * time.Second,
		"graph":             2 * time.Minute,
		// 20s — short enough that the "last call N sec ago" indicator stays
		// honest while the user is watching for first-call-after-install.
		"sdk_health":        20 * time.Second,
		"regressions":       2 * time.Minute,
		// Prompts page is a per-version aggregate — same cadence as
		// other breakdown-style endpoints. Tight enough for operators
		// to see a new prompt version's metrics fill in quickly after
		// deploy.
		"prompts":           60 * time.Second,
	}

	// Per-org rate limit: 600 req/min per org_id. Sized for ~10-15 active
	// users on the dashboard simultaneously — each user's dashboard polls 6-8
	// endpoints every 30s (~16 req/min/user), so 600/min gives ~35-user
	// headroom before throttling. Bumped from 100/min after the third-pass
	// review noted an 8-person team would self-throttle. (S-4 from review.)
	//
	// Limit counter is in-process per-replica; multi-replica deploys
	// multiply the effective ceiling proportionally. For cluster-wide
	// limiting, distribute via httprate-redis or Redis token bucket.
	//
	// Falls back to RemoteAddr if claims are somehow absent (defensive,
	// shouldn't fire because Authenticate ran upstream).
	perOrgRateLimit := httprate.Limit(600, time.Minute,
		httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
			if claims := apimw.ClaimsFromCtx(r.Context()); claims != nil {
				return "org:" + claims.OrgID, nil
			}
			return r.RemoteAddr, nil
		}),
	)

	r.Group(func(r chi.Router) {
		r.Use(apimw.Authenticate(authCfg))
		r.Use(perOrgRateLimit)
		r.Use(apimw.ValidateTimestamps) // rejects non-RFC3339 ?from= / ?to= before handlers see them

		r.With(apimw.Cache(rdb, cacheTTLs["overview"], "overview")).
			Get("/api/v1/overview", func(w http.ResponseWriter, req *http.Request) {
				strictHandler.GetOverview(w, req, extractOverviewParams(req))
			})

		r.With(apimw.Cache(rdb, cacheTTLs["traces"], "traces")).
			Get("/api/v1/traces", func(w http.ResponseWriter, req *http.Request) {
				// Stash provider/user_id/environment/feature_name on the context
				// for the strict handler to read (see handler/traces_filters.go).
				req = req.WithContext(handler.WithTraceFilters(req))
				strictHandler.ListTraces(w, req, extractListTracesParams(req))
			})

		r.With(apimw.Cache(rdb, cacheTTLs["trace_detail"], "trace_detail")).
			Get("/api/v1/traces/{span_id}", func(w http.ResponseWriter, req *http.Request) {
				strictHandler.GetTrace(w, req, chi.URLParam(req, "span_id"), extractTraceParams(req))
			})

		r.With(apimw.Cache(rdb, cacheTTLs["metrics_cost"], "metrics_cost")).
			Get("/api/v1/metrics/cost", func(w http.ResponseWriter, req *http.Request) {
				strictHandler.GetCostMetrics(w, req, extractMetricsParams(req))
			})

		r.With(apimw.Cache(rdb, cacheTTLs["metrics_latency"], "metrics_latency")).
			Get("/api/v1/metrics/latency", func(w http.ResponseWriter, req *http.Request) {
				strictHandler.GetLatencyMetrics(w, req, extractLatencyMetricsParams(req))
			})

		r.With(apimw.Cache(rdb, cacheTTLs["metrics_errors"], "metrics_errors")).
			Get("/api/v1/metrics/errors", func(w http.ResponseWriter, req *http.Request) {
				strictHandler.GetErrorMetrics(w, req, extractErrorMetricsParams(req))
			})

		// /api/v1/alerts kept as a back-compat redirect to /alerts/events. The
		// strict-handler stub is gone — alerts have real data now.
		r.Get("/api/v1/alerts", alertsHandler.ListEvents)

		// Real alerts API (no cache — these mutate, or stream recent events).
		r.Get("/api/v1/alerts/rules", alertsHandler.ListRules)
		r.Post("/api/v1/alerts/rules", alertsHandler.CreateRule)
		r.Patch("/api/v1/alerts/rules/{id}", alertsHandler.PatchRule)
		r.Delete("/api/v1/alerts/rules/{id}", alertsHandler.DeleteRule)
		r.Get("/api/v1/alerts/events", alertsHandler.ListEvents)
		// Sample offending traces under one event — closes the alert→trace loop.
		r.Get("/api/v1/alerts/events/{id}/traces", alertsHandler.EventTraces)

		// Hand-wired (not part of the generated strict server) — see
		// handler/breakdown.go for the rationale.
		r.With(apimw.Cache(rdb, cacheTTLs["breakdown"], "breakdown")).
			Get("/api/v1/breakdown", srv.GetBreakdownHTTP)

		// Hand-wired trace-tree endpoint (same rationale).
		r.With(apimw.Cache(rdb, cacheTTLs["trace_tree"], "trace_tree")).
			Get("/api/v1/traces/tree/{trace_id}", srv.GetTraceTreeHTTP)

		// Hand-wired metrics endpoints that aren't in the strict server.
		r.With(apimw.Cache(rdb, cacheTTLs["top_movers"], "top_movers")).
			Get("/api/v1/metrics/top-movers", srv.GetTopMoversHTTP)
		r.With(apimw.Cache(rdb, cacheTTLs["errors_by_status"], "errors_by_status")).
			Get("/api/v1/metrics/errors-by-status", srv.GetErrorsByStatusHTTP)

		// Sessions list — grouped by session_id, sorted by recency.
		r.With(apimw.Cache(rdb, cacheTTLs["sessions"], "sessions")).
			Get("/api/v1/sessions", srv.GetSessionsHTTP)

		// Prompts page — per-version cost / latency / error-rate aggregates.
		// Hand-wired; not part of the generated strict server (same rationale
		// as /breakdown). Drill-in from a row → /dashboard/traces filtered
		// by ?prompt_version=… is what carries the KPI-attribution thesis.
		r.With(apimw.Cache(rdb, cacheTTLs["prompts"], "prompts")).
			Get("/api/v1/prompts", srv.GetPromptsHTTP)

		// Flow Map — aggregate parent→child call graph for the window.
		r.With(apimw.Cache(rdb, cacheTTLs["graph"], "graph")).
			Get("/api/v1/graph", srv.GetGraphHTTP)
		// Flow Map expand — call-level breakdown of one aggregate node.
		r.With(apimw.Cache(rdb, cacheTTLs["graph"], "graph")).
			Get("/api/v1/graph/expand", srv.GetGraphExpandHTTP)

		// SDK health — "is my data flowing?" surfaced on Overview.
		r.With(apimw.Cache(rdb, cacheTTLs["sdk_health"], "sdk_health")).
			Get("/api/v1/sdk/health", srv.GetSDKHealthHTTP)

		// Auto-detected regressions — surfaced on Overview as a panel that
		// turns Top Movers into actionable "this got worse" signals.
		r.With(apimw.Cache(rdb, cacheTTLs["regressions"], "regressions")).
			Get("/api/v1/regressions", srv.GetRegressionsHTTP)

		// Saved views (URL bookmarks). No cache — list is small + writes need
		// to reflect immediately so the dropdown updates after Save.
		r.Get("/api/v1/views", savedViewsHandler.ListSavedViews)
		r.Post("/api/v1/views", savedViewsHandler.CreateSavedView)
		r.Delete("/api/v1/views/{id}", savedViewsHandler.DeleteSavedView)

		// API key management (Settings → API Keys). No cache — the list
		// must reflect mutations immediately so the user sees a created
		// key (or a revoked one disappear from the active list) without
		// a refresh.
		//
		// All three routes are scoped to the org_id in the URL. The handler
		// then asserts the URL org matches the authenticated claims.OrgID
		// — duplicating the check the rest of the API does inside the
		// strict server.
		// Redis handle is wired in so RevokeKey can DEL the positive cache
		// entry + write the 5-minute negative-cache marker. Without it the
		// revoke endpoint still works (Postgres flag is authoritative) but
		// the previously-cached entry would keep authenticating for up to
		// 60s — which is what the Round-7 reviewer correctly flagged.
		keysHandler := &handler.APIKeysServer{Q: queries, Redis: rdb}
		r.Get("/api/v1/orgs/{org_id}/keys", keysHandler.ListKeys)
		r.Post("/api/v1/orgs/{org_id}/keys", keysHandler.CreateKey)
		r.Delete("/api/v1/orgs/{org_id}/keys/{key_id}", keysHandler.RevokeKey)
	})

	log.Info("api server starting", zap.String("port", port))
	if err := http.ListenAndServe(":"+port, r); err != nil {
		log.Fatal("server error", zap.Error(err))
	}
}

// -- param extractors --

func extractOverviewParams(r *http.Request) gen.GetOverviewParams {
	q := r.URL.Query()
	return gen.GetOverviewParams{
		OrgId: q.Get("org_id"),
		From:  parseTime(q.Get("from")),
		To:    parseTime(q.Get("to")),
	}
}

func extractListTracesParams(r *http.Request) gen.ListTracesParams {
	q := r.URL.Query()
	p := gen.ListTracesParams{
		OrgId: q.Get("org_id"),
		From:  parseTime(q.Get("from")),
		To:    parseTime(q.Get("to")),
	}
	if v := q.Get("cursor"); v != "" {
		p.Cursor = &v
	}
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			p.Limit = &n
		}
	}
	if v := q.Get("model"); v != "" {
		p.Model = &v
	}
	if v := q.Get("status"); v != "" {
		s := gen.ListTracesParamsStatus(v)
		p.Status = &s
	}
	return p
}

func extractTraceParams(r *http.Request) gen.GetTraceParams {
	return gen.GetTraceParams{OrgId: r.URL.Query().Get("org_id")}
}

func extractMetricsParams(r *http.Request) gen.GetCostMetricsParams {
	q := r.URL.Query()
	p := gen.GetCostMetricsParams{
		OrgId: q.Get("org_id"),
		From:  parseTime(q.Get("from")),
		To:    parseTime(q.Get("to")),
	}
	if v := q.Get("granularity"); v != "" {
		g := gen.GetCostMetricsParamsGranularity(v)
		p.Granularity = &g
	}
	return p
}

func extractLatencyMetricsParams(r *http.Request) gen.GetLatencyMetricsParams {
	q := r.URL.Query()
	p := gen.GetLatencyMetricsParams{
		OrgId: q.Get("org_id"),
		From:  parseTime(q.Get("from")),
		To:    parseTime(q.Get("to")),
	}
	if v := q.Get("granularity"); v != "" {
		g := gen.GetLatencyMetricsParamsGranularity(v)
		p.Granularity = &g
	}
	return p
}

func extractErrorMetricsParams(r *http.Request) gen.GetErrorMetricsParams {
	q := r.URL.Query()
	p := gen.GetErrorMetricsParams{
		OrgId: q.Get("org_id"),
		From:  parseTime(q.Get("from")),
		To:    parseTime(q.Get("to")),
	}
	if v := q.Get("granularity"); v != "" {
		g := gen.GetErrorMetricsParamsGranularity(v)
		p.Granularity = &g
	}
	return p
}

func extractAlertsParams(r *http.Request) gen.ListAlertsParams {
	return gen.ListAlertsParams{OrgId: r.URL.Query().Get("org_id")}
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
