package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"go.uber.org/zap"
)

// dimColumns: alert rule dim filter keys → ClickHouse column expressions. Mirrors
// the breakdown query mapping; kept in lockstep so users get consistent
// dimension semantics across cost explorer and alerts.
var dimColumns = map[string]string{
	"model":       "model",
	"provider":    "provider",
	"feature":     "feature_name",
	"user":        "coalesce(user_id, '')",
	"environment": "environment",
}

// Evaluator runs all enabled rules on a tick. Single-instance for now —
// multi-replica would need a distributed lock to avoid duplicate alerts.
type Evaluator struct {
	store *Store
	ch    driver.Conn
	log   *zap.Logger
	http  *http.Client
}

func NewEvaluator(store *Store, ch driver.Conn, log *zap.Logger) *Evaluator {
	return &Evaluator{
		store: store,
		ch:    ch,
		log:   log,
		http: &http.Client{
			Timeout: 5 * time.Second,
			// SECURITY: never follow redirects. The SSRF guard validates the
			// initial URL; if Slack ever returns a 3xx (or an attacker
			// somehow gets a custom redirector inside hooks.slack.com), we
			// don't want the client chasing it to an internal address.
			// (S1 from second-pass security review.)
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// Run loops forever, evaluating rules every interval. Stops cleanly when ctx is cancelled.
func (e *Evaluator) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 60 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	e.log.Info("alerts evaluator started", zap.Duration("interval", interval))

	// First tick immediately so newly-created rules don't wait a full interval.
	e.runOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			e.log.Info("alerts evaluator stopping")
			return
		case <-t.C:
			e.runOnce(ctx)
		}
	}
}

func (e *Evaluator) runOnce(ctx context.Context) {
	rules, err := e.store.ListEnabledRulesAcrossOrgs(ctx)
	if err != nil {
		e.log.Warn("alerts: list rules failed", zap.Error(err))
		return
	}
	for _, r := range rules {
		// Per-rule isolation: one rule's failure shouldn't block others.
		func(r Rule) {
			defer func() {
				if rec := recover(); rec != nil {
					e.log.Error("alerts: rule evaluation panic", zap.String("rule_id", r.ID), zap.Any("panic", rec))
				}
			}()
			// Postgres advisory lock — first replica to grab the lock on this
			// tick gets to evaluate the rule. Other replicas skip silently.
			// Without this, running multiple API replicas (which we'll do for
			// HA) means every replica fires a separate Slack notification for
			// the same alert — once-per-replica spam. (T5/leader-election
			// from review.)
			locked, unlock, err := e.store.TryEvalLock(ctx, r.ID)
			if err != nil {
				e.log.Warn("alerts: try-lock failed", zap.String("rule_id", r.ID), zap.Error(err))
				return
			}
			if !locked {
				// Another replica is handling this rule this tick. Normal in
				// multi-replica deployments.
				return
			}
			defer unlock()

			if err := e.evaluateRule(ctx, r); err != nil {
				e.log.Warn("alerts: rule evaluation failed",
					zap.String("rule_id", r.ID), zap.String("rule_name", r.Name), zap.Error(err))
			}
		}(r)
	}
}

// hysteresisFactor is the fraction of the firing threshold below which we
// declare an alert resolved. Without this, a value oscillating around the
// threshold (e.g. 9.9 ↔ 10.1 against threshold=10) generates alert / resolve
// / alert / resolve every evaluation tick — Slack spam, useless to humans.
// 10% buffer is a common monitoring-system default (Datadog, Grafana).
//
// IMPORTANT: this math assumes CEILING-style rules — i.e. "value > threshold
// is bad, recovery is value going down." All three current rule types
// (cost_spike, error_rate, latency_p99) are ceilings, so this is correct.
//
// If a FLOOR-style rule is ever added (e.g. "fire when call_volume drops
// below X" — `regressions.go` already detects this concept but doesn't yet
// expose it as a rule type), this constant becomes wrong-signed: recovery
// for a floor is value GOING UP, threshold / 0.9 = recovery point. Switch
// on r.Type in evaluateRule() if/when that lands. (T2 from review.)
const hysteresisFactor = 0.9

// evaluateRule computes the metric value, decides crossed-up vs back-down,
// and opens/closes events accordingly. Uses hysteresis: fires above the
// threshold, only resolves once the value drops below threshold * 0.9.
func (e *Evaluator) evaluateRule(ctx context.Context, r Rule) error {
	value, err := e.computeValue(ctx, r)
	if err != nil {
		return fmt.Errorf("compute: %w", err)
	}

	open, err := e.store.OpenEventForRule(ctx, r.ID)
	if err != nil {
		return fmt.Errorf("read open event: %w", err)
	}

	// Asymmetric thresholds — close has a deadband below open to suppress flap.
	firing := value > r.Threshold
	recovered := value <= r.Threshold*hysteresisFactor

	switch {
	case firing && open == nil:
		// Newly firing — create event + push.
		msg := buildMessage(r, value)
		ev, err := e.store.InsertEvent(ctx, r.ID, value, msg)
		if err != nil {
			return fmt.Errorf("insert event: %w", err)
		}
		e.log.Info("alert fired", zap.String("rule", r.Name), zap.Float64("value", value), zap.Float64("threshold", r.Threshold))
		e.maybeNotify(ctx, r, ev, false)

	case firing && open != nil:
		// Still firing — no new event, no re-notification.

	case recovered && open != nil:
		// Dropped below the resolve threshold — close the event + push resolution.
		if err := e.store.ResolveOpenEvent(ctx, r.ID); err != nil {
			return fmt.Errorf("resolve: %w", err)
		}
		e.log.Info("alert resolved", zap.String("rule", r.Name), zap.Float64("value", value))
		open.Value = value
		open.Message = fmt.Sprintf("Recovered: %s", buildMessage(r, value))
		e.maybeNotify(ctx, r, open, true)

	// Implicit deadband: value is between resolve-threshold and fire-threshold
	// with an open event — stay open, don't resolve, don't re-notify.
	// (This is the case the old !crossed branch incorrectly closed.)

	case !firing && open == nil:
		// Steady-state below threshold — nothing to do.
	}
	return nil
}

// computeValue runs the appropriate ClickHouse aggregate for the rule type.
func (e *Evaluator) computeValue(ctx context.Context, r Rule) (float64, error) {
	windowStart := time.Now().Add(-time.Duration(r.WindowSeconds) * time.Second).UTC()
	windowEnd := time.Now().UTC()

	// Build dim_filter WHERE conjuncts.
	conds := []string{}
	args := []any{
		driver.NamedValue{Name: "org_id", Value: r.OrgID},
		driver.NamedValue{Name: "from", Value: windowStart.Format("2006-01-02 15:04:05")},
		driver.NamedValue{Name: "to", Value: windowEnd.Format("2006-01-02 15:04:05")},
	}
	i := 0
	for dim, val := range r.DimFilter {
		col, ok := dimColumns[dim]
		if !ok {
			return 0, fmt.Errorf("invalid dim_filter key: %s", dim)
		}
		name := fmt.Sprintf("f%d", i)
		conds = append(conds, fmt.Sprintf("%s = {%s:String}", col, name))
		args = append(args, driver.NamedValue{Name: name, Value: val})
		i++
	}
	extraWhere := ""
	if len(conds) > 0 {
		extraWhere = " AND " + strings.Join(conds, " AND ")
	}

	var metricExpr string
	switch r.Type {
	case RuleCostSpike:
		metricExpr = "sum(cost_usd)"
	case RuleErrorRate:
		metricExpr = "countIf(status = 'error') * 100.0 / nullIf(count(), 0)"
	case RuleLatencyP99:
		metricExpr = "quantile(0.99)(latency_ms)"
	default:
		return 0, fmt.Errorf("unknown rule type: %s", r.Type)
	}

	// kind='llm' — alert thresholds are defined over provider-call metrics
	// (cost, latency, error rate, p99). Workflow rows would inflate counts
	// and skew averages — a single sdk.trace() block could trip an error-rate
	// alert when the LLM calls inside all succeeded but the block threw on
	// some non-LLM operation. See services-go/api/internal/query/overview.go
	// for the broader rationale.
	q := fmt.Sprintf(`
SELECT ifNotFinite(%s, 0) AS value
FROM llm_calls
WHERE org_id = {org_id:String}
  AND kind = 'llm'
  AND timestamp >= {from:DateTime('UTC')}
  AND timestamp <  {to:DateTime('UTC')}%s
`, metricExpr, extraWhere)

	var v float64
	if err := e.ch.QueryRow(ctx, q, args...).Scan(&v); err != nil {
		return 0, fmt.Errorf("query: %w", err)
	}
	return v, nil
}

func buildMessage(r Rule, value float64) string {
	switch r.Type {
	case RuleCostSpike:
		return fmt.Sprintf("Cost over last %ds is $%.4f (threshold $%.4f)", r.WindowSeconds, value, r.Threshold)
	case RuleErrorRate:
		return fmt.Sprintf("Error rate over last %ds is %.2f%% (threshold %.2f%%)", r.WindowSeconds, value, r.Threshold)
	case RuleLatencyP99:
		return fmt.Sprintf("P99 latency over last %ds is %.0fms (threshold %.0fms)", r.WindowSeconds, value, r.Threshold)
	}
	return fmt.Sprintf("Value %.4f exceeded threshold %.4f", value, r.Threshold)
}

// maybeNotify dispatches to the configured channel. For 'none' it's a no-op
// (the event is still stored and visible on the Alerts page).
func (e *Evaluator) maybeNotify(ctx context.Context, r Rule, ev *Event, resolved bool) {
	if r.ChannelType == ChannelNone {
		return
	}
	if r.ChannelType == ChannelSlack {
		url := r.ChannelConfig["webhook_url"]
		if url == "" {
			e.log.Warn("alerts: slack channel missing webhook_url", zap.String("rule_id", r.ID))
			return
		}
		// SSRF guard. webhook_url is owner-supplied; without restriction it
		// becomes a primitive for the evaluator to POST to any internal URL
		// (k8s API, cloud metadata IMDS, internal Redis on HTTP). Slack's
		// webhook hosts are well-known — restrict to those two.
		if !isValidSlackWebhook(url) {
			e.log.Warn("alerts: rejected non-Slack webhook URL (SSRF guard)", zap.String("rule_id", r.ID))
			return
		}
		emoji := "🔴"
		if resolved {
			emoji = "✅"
		}
		payload, _ := json.Marshal(map[string]string{
			"text": fmt.Sprintf("%s *%s*\n%s", emoji, r.Name, ev.Message),
		})
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(payload))
		if err != nil {
			e.log.Warn("alerts: build slack request failed", zap.Error(err))
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := e.http.Do(req)
		if err != nil {
			e.log.Warn("alerts: slack POST failed", zap.Error(err))
			return
		}
		// Drain before Close so the HTTP client can reuse the connection
		// (keep-alive) on the next Slack post. Without io.Copy, every alert
		// opens a fresh TCP+TLS handshake — negligible at v1 volume but
		// trivially fixable.
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode >= 300 {
			e.log.Warn("alerts: slack returned non-2xx", zap.Int("status", resp.StatusCode), zap.String("rule_id", r.ID))
		}
	}
}

// allowedSlackHosts is the canonical set of Slack webhook hosts. Adding new
// entries is rare and intentional — we'd rather reject a legitimate edge case
// than allow a compromised owner to pivot into the internal network.
var allowedSlackHosts = map[string]struct{}{
	"hooks.slack.com":      {},
	"slack.com":            {}, // for legacy / non-incoming-webhook integrations
}

// isValidSlackWebhook validates a webhook URL for the alerts SSRF guard.
// We require https + a Slack-owned host; everything else is rejected. The
// scheme check kills `http://10.0.0.1` style internal-network probes; the
// host allowlist kills DNS-rebinding attempts (the resolved IP can change,
// but the hostname can't be `evil.com` and pass).
func isValidSlackWebhook(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme != "https" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	_, ok := allowedSlackHosts[host]
	return ok
}
