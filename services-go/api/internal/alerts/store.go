package alerts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// RuleType is one of the three v1 alert kinds. See evaluator.go for what each evaluates.
type RuleType string

const (
	RuleCostSpike  RuleType = "cost_spike"
	RuleErrorRate  RuleType = "error_rate"
	RuleLatencyP99 RuleType = "latency_p99"
)

func validRuleType(t string) bool {
	switch RuleType(t) {
	case RuleCostSpike, RuleErrorRate, RuleLatencyP99:
		return true
	}
	return false
}

// ChannelType is the notification surface — 'none' stores events without
// pushing anywhere (still visible on the Alerts page).
type ChannelType string

const (
	ChannelNone  ChannelType = "none"
	ChannelSlack ChannelType = "slack"
)

func validChannelType(t string) bool {
	return ChannelType(t) == ChannelNone || ChannelType(t) == ChannelSlack
}

type Rule struct {
	ID            string            `json:"id"`
	OrgID         string            `json:"-"`
	Name          string            `json:"name"`
	Type          RuleType          `json:"type"`
	Threshold     float64           `json:"threshold"`
	WindowSeconds int               `json:"window_seconds"`
	DimFilter     map[string]string `json:"dim_filter"`
	ChannelType   ChannelType       `json:"channel_type"`
	ChannelConfig map[string]string `json:"channel_config"`
	Enabled       bool              `json:"enabled"`
	CreatedAt     time.Time         `json:"created_at"`
}

type Event struct {
	ID         string     `json:"id"`
	RuleID     string     `json:"rule_id"`
	RuleName   string     `json:"rule_name"`
	FiredAt    time.Time  `json:"fired_at"`
	Value      float64    `json:"value"`
	Message    string     `json:"message"`
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
}

// Store wraps the *sql.DB with alert-specific queries. Pure data layer —
// evaluation logic lives separately in evaluator.go.
type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel validation errors. Used by handlers (via errors.Is) to decide
// which CreateRule errors are safe to surface to the API caller verbatim,
// vs which leak schema details and should be replaced with a generic
// message. Replaces the previous prefix-sniffing approach in
// handler/alerts.go — that was fragile to copy/paste rewording.
// ─────────────────────────────────────────────────────────────────────────────

var (
	ErrRuleNameRequired   = errors.New("org_id and name required")
	ErrInvalidRuleType    = errors.New("invalid rule type")
	ErrInvalidChannelType = errors.New("invalid channel type")
	ErrWindowSecondsRange = errors.New("window_seconds must be between 60 and 86400")
	ErrThresholdInvalid   = errors.New("threshold must be positive")
)

// TryEvalLock attempts a session-scoped advisory lock on a rule for the
// duration of one evaluation tick. Returns (true, unlock-fn) if acquired,
// (false, nil) otherwise. Use to dedupe alert evaluation across multiple API
// replicas — without this, every replica would independently fire events for
// the same rule on the same tick, sending duplicate Slack notifications.
//
// Implementation: pg_try_advisory_lock(bigint) with a 64-bit FNV-1a hash of
// the rule ID. We use the single-bigint form rather than (int4, int4) because
// the 64-bit key space (~1.8e19) makes collisions effectively impossible
// across realistic rule counts. FNV-32 has birthday-bound collisions around
// 65K rules per cluster — a busy multi-tenant deployment could hit that.
// FNV-64 pushes it to ~5 billion rules before collision risk matters.
//
// Session-scoped (not xact-scoped) so we don't have to hold a transaction
// open across ClickHouse queries — that would pin Postgres connections for
// tens of seconds. The unlock fn MUST be deferred by the caller; we use the
// SAME *sql.Conn for the unlock query so the lock can definitely be released,
// and close the conn as a backstop (session-scoped locks die with the session).
func (s *Store) TryEvalLock(ctx context.Context, ruleID string) (locked bool, unlock func(), err error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return false, nil, fmt.Errorf("acquire conn: %w", err)
	}
	// FNV-1a 64-bit. The bigint form of pg_try_advisory_lock takes a single
	// int8; we cast our uint64 hash through int64 (bit pattern preserved).
	const fnv64Offset uint64 = 14695981039346656037
	const fnv64Prime uint64 = 1099511628211
	h := fnv64Offset
	for i := 0; i < len(ruleID); i++ {
		h ^= uint64(ruleID[i])
		h *= fnv64Prime
	}
	lockKey := int64(h) // overflow OK — bit pattern is what matters

	row := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1::bigint)", lockKey)
	if err := row.Scan(&locked); err != nil {
		conn.Close() //nolint:errcheck
		return false, nil, fmt.Errorf("try lock: %w", err)
	}
	if !locked {
		conn.Close() //nolint:errcheck
		return false, nil, nil
	}
	unlock = func() {
		_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock($1::bigint)", lockKey)
		conn.Close() //nolint:errcheck
	}
	return true, unlock, nil
}

func (s *Store) CreateRule(ctx context.Context, r *Rule) (*Rule, error) {
	// Wrap each validation failure with a sentinel error so handlers can
	// errors.Is and decide to surface the message vs. swap for a generic one.
	// (Replaces the previous prefix-sniffing in handler/alerts.go — that was
	// fragile to message-text rewording.)
	if r.OrgID == "" || r.Name == "" {
		return nil, ErrRuleNameRequired
	}
	if !validRuleType(string(r.Type)) {
		return nil, fmt.Errorf("%w: %s", ErrInvalidRuleType, r.Type)
	}
	if !validChannelType(string(r.ChannelType)) {
		return nil, fmt.Errorf("%w: %s", ErrInvalidChannelType, r.ChannelType)
	}
	if r.WindowSeconds < 60 || r.WindowSeconds > 86400 {
		return nil, ErrWindowSecondsRange
	}
	// Threshold must be positive. Without this gate, threshold=0 makes every
	// non-zero metric value fire (cost_spike on every $0.01, error_rate on
	// every >0% error) → Slack-storm. threshold=-1 fires forever. The current
	// rule types are all ceiling-style ("value > threshold = bad") so a
	// non-positive threshold is always operator error.
	if r.Threshold <= 0 {
		return nil, fmt.Errorf("%w (got %v)", ErrThresholdInvalid, r.Threshold)
	}
	if r.DimFilter == nil {
		r.DimFilter = map[string]string{}
	}
	if r.ChannelConfig == nil {
		r.ChannelConfig = map[string]string{}
	}
	dimJSON, _ := json.Marshal(r.DimFilter)
	chanJSON, _ := json.Marshal(r.ChannelConfig)

	out := &Rule{}
	out.DimFilter = map[string]string{}
	out.ChannelConfig = map[string]string{}
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO alert_rules (org_id, name, type, threshold, window_seconds, dim_filter, channel_type, channel_config, enabled)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, org_id, name, type, threshold, window_seconds, dim_filter::text, channel_type, channel_config::text, enabled, created_at
	`, r.OrgID, r.Name, string(r.Type), r.Threshold, r.WindowSeconds, string(dimJSON), string(r.ChannelType), string(chanJSON), r.Enabled).
		Scan(&out.ID, &out.OrgID, &out.Name, (*string)(&out.Type), &out.Threshold, &out.WindowSeconds,
			scanJSON{&out.DimFilter}, (*string)(&out.ChannelType), scanJSON{&out.ChannelConfig}, &out.Enabled, &out.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("insert alert rule: %w", err)
	}
	return out, nil
}

// scanJSON is a tiny sql.Scanner that unmarshals a JSON-as-text column into a map.
type scanJSON struct{ dst *map[string]string }

func (s scanJSON) Scan(src any) error {
	if src == nil {
		*s.dst = map[string]string{}
		return nil
	}
	var raw []byte
	switch v := src.(type) {
	case []byte:
		raw = v
	case string:
		raw = []byte(v)
	default:
		return fmt.Errorf("scanJSON: unexpected source type %T", src)
	}
	if len(raw) == 0 {
		*s.dst = map[string]string{}
		return nil
	}
	return json.Unmarshal(raw, s.dst)
}

func (s *Store) ListRules(ctx context.Context, orgID string) ([]Rule, error) {
	// LIMIT is a UI guard only — this list powers the org-scoped Alerts page,
	// which renders a row per rule. The evaluator does NOT use this method (it
	// calls ListEnabledRulesAcrossOrgs, which is intentionally unbounded), so
	// capping here can't starve evaluation. 500 is far above any realistic
	// per-org rule count.
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, org_id, name, type, threshold, window_seconds, dim_filter::text, channel_type, channel_config::text, enabled, created_at
		FROM alert_rules
		WHERE org_id = $1
		ORDER BY created_at DESC
		LIMIT 500
	`, orgID)
	if err != nil {
		return nil, fmt.Errorf("list alert rules: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]Rule, 0, 16)
	for rows.Next() {
		r := Rule{DimFilter: map[string]string{}, ChannelConfig: map[string]string{}}
		if err := rows.Scan(&r.ID, &r.OrgID, &r.Name, (*string)(&r.Type), &r.Threshold, &r.WindowSeconds,
			scanJSON{&r.DimFilter}, (*string)(&r.ChannelType), scanJSON{&r.ChannelConfig}, &r.Enabled, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan alert rule: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListEnabledRulesAcrossOrgs is for the evaluator goroutine — it doesn't have an
// org scope, it scans every active rule.
func (s *Store) ListEnabledRulesAcrossOrgs(ctx context.Context) ([]Rule, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, org_id, name, type, threshold, window_seconds, dim_filter::text, channel_type, channel_config::text, enabled, created_at
		FROM alert_rules
		WHERE enabled = true
	`)
	if err != nil {
		return nil, fmt.Errorf("list enabled rules: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]Rule, 0, 32)
	for rows.Next() {
		r := Rule{DimFilter: map[string]string{}, ChannelConfig: map[string]string{}}
		if err := rows.Scan(&r.ID, &r.OrgID, &r.Name, (*string)(&r.Type), &r.Threshold, &r.WindowSeconds,
			scanJSON{&r.DimFilter}, (*string)(&r.ChannelType), scanJSON{&r.ChannelConfig}, &r.Enabled, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) SetEnabled(ctx context.Context, orgID, ruleID string, enabled bool) error {
	res, err := s.db.ExecContext(ctx, `UPDATE alert_rules SET enabled = $1 WHERE id = $2 AND org_id = $3`, enabled, ruleID, orgID)
	if err != nil {
		return fmt.Errorf("set enabled: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) DeleteRule(ctx context.Context, orgID, ruleID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM alert_rules WHERE id = $1 AND org_id = $2`, ruleID, orgID)
	if err != nil {
		return fmt.Errorf("delete rule: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// OpenEventForRule returns the most recent open (resolved_at IS NULL) event for
// a rule, or nil if none. Used to dedupe: if an alert is already open we don't
// create a duplicate event on the next evaluation.
func (s *Store) OpenEventForRule(ctx context.Context, ruleID string) (*Event, error) {
	var e Event
	err := s.db.QueryRowContext(ctx, `
		SELECT id, rule_id, fired_at, value, message FROM alert_events
		WHERE rule_id = $1 AND resolved_at IS NULL
		ORDER BY fired_at DESC LIMIT 1
	`, ruleID).Scan(&e.ID, &e.RuleID, &e.FiredAt, &e.Value, &e.Message)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open event: %w", err)
	}
	return &e, nil
}

func (s *Store) InsertEvent(ctx context.Context, ruleID string, value float64, message string) (*Event, error) {
	var e Event
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO alert_events (rule_id, value, message)
		VALUES ($1, $2, $3)
		RETURNING id, rule_id, fired_at, value, message
	`, ruleID, value, message).Scan(&e.ID, &e.RuleID, &e.FiredAt, &e.Value, &e.Message)
	if err != nil {
		return nil, fmt.Errorf("insert event: %w", err)
	}
	return &e, nil
}

func (s *Store) ResolveOpenEvent(ctx context.Context, ruleID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE alert_events SET resolved_at = now()
		WHERE rule_id = $1 AND resolved_at IS NULL
	`, ruleID)
	if err != nil {
		return fmt.Errorf("resolve event: %w", err)
	}
	return nil
}

// EventWithRule bundles an event with the rule that fired it, scoped to an
// org. Used by the alert→trace drill-down to know which window + dim filter
// to use when looking up offending traces.
type EventWithRule struct {
	Event Event
	Rule  Rule
}

// GetEventWithRule returns one event + its rule, both scoped to orgID. Used
// by /api/v1/alerts/events/{id}/traces — we need the rule to know what
// window and dim_filter the event was evaluated against.
func (s *Store) GetEventWithRule(ctx context.Context, orgID, eventID string) (*EventWithRule, error) {
	var ewr EventWithRule
	ewr.Rule.DimFilter = map[string]string{}
	ewr.Rule.ChannelConfig = map[string]string{}
	err := s.db.QueryRowContext(ctx, `
		SELECT
		    e.id, e.rule_id, r.name AS rule_name, e.fired_at, e.value, e.message, e.resolved_at,
		    r.id, r.org_id, r.name, r.type, r.threshold, r.window_seconds,
		    r.dim_filter::text, r.channel_type, r.channel_config::text, r.enabled, r.created_at
		FROM alert_events e
		JOIN alert_rules r ON r.id = e.rule_id
		WHERE e.id = $1 AND r.org_id = $2
	`, eventID, orgID).Scan(
		&ewr.Event.ID, &ewr.Event.RuleID, &ewr.Event.RuleName, &ewr.Event.FiredAt,
		&ewr.Event.Value, &ewr.Event.Message, &ewr.Event.ResolvedAt,
		&ewr.Rule.ID, &ewr.Rule.OrgID, &ewr.Rule.Name, (*string)(&ewr.Rule.Type), &ewr.Rule.Threshold,
		&ewr.Rule.WindowSeconds, scanJSON{&ewr.Rule.DimFilter}, (*string)(&ewr.Rule.ChannelType),
		scanJSON{&ewr.Rule.ChannelConfig}, &ewr.Rule.Enabled, &ewr.Rule.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get event with rule: %w", err)
	}
	return &ewr, nil
}

func (s *Store) ListEvents(ctx context.Context, orgID string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT e.id, e.rule_id, r.name, e.fired_at, e.value, e.message, e.resolved_at
		FROM alert_events e
		JOIN alert_rules r ON r.id = e.rule_id
		WHERE r.org_id = $1
		ORDER BY e.fired_at DESC
		LIMIT $2
	`, orgID, limit)
	if err != nil {
		return nil, fmt.Errorf("list events: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	out := make([]Event, 0, 32)
	for rows.Next() {
		var e Event
		var resolved sql.NullTime
		if err := rows.Scan(&e.ID, &e.RuleID, &e.RuleName, &e.FiredAt, &e.Value, &e.Message, &resolved); err != nil {
			return nil, err
		}
		if resolved.Valid {
			t := resolved.Time
			e.ResolvedAt = &t
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
