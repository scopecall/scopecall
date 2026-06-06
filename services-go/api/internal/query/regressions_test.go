package query

import "testing"

// agg builds an aggregate with sensible defaults. Test cases override only
// the fields that matter for the rule under test — keeps the table compact
// and the intent visible.
func agg(calls uint64, cost, p99, errRate float64) aggregate {
	return aggregate{
		feature:   "summarize",
		model:     "gpt-4o",
		calls:     calls,
		cost:      cost,
		p99Lat:    p99,
		errorRate: errRate,
	}
}

func TestDetectP99Regression(t *testing.T) {
	tests := []struct {
		name    string
		curr    aggregate
		prior   aggregate
		wantNil bool
		wantSev RegressionSeverity
	}{
		{
			name:    "below minCallsForDetection → no signal",
			curr:    agg(10, 0, 1000, 0),
			prior:   agg(10, 0, 500, 0),
			wantNil: true,
		},
		{
			name:    "current p99 below floor → no signal (avoid noise on fast ops)",
			curr:    agg(100, 0, 200, 0), // 200ms < p99MinCurrentMS (500)
			prior:   agg(100, 0, 100, 0),
			wantNil: true,
		},
		{
			name:    "prior p99 below floor → no signal",
			curr:    agg(100, 0, 1000, 0),
			prior:   agg(100, 0, 50, 0), // 50ms < p99MinPriorMS (100)
			wantNil: true,
		},
		{
			name:    "exactly at +50% threshold → watch",
			curr:    agg(100, 0, 1500, 0), // 1500 / 1000 = +50%
			prior:   agg(100, 0, 1000, 0),
			wantSev: SeverityWatch,
		},
		{
			name:    "doubled exactly → critical",
			curr:    agg(100, 0, 2000, 0), // 2000 / 1000 = +100%
			prior:   agg(100, 0, 1000, 0),
			wantSev: SeverityCritical,
		},
		{
			name:    "tripled → critical",
			curr:    agg(100, 0, 3000, 0),
			prior:   agg(100, 0, 1000, 0),
			wantSev: SeverityCritical,
		},
		{
			name:    "below 50% (49.99%) → no signal",
			curr:    agg(100, 0, 1499, 0), // 1499/1000 = +49.9%
			prior:   agg(100, 0, 1000, 0),
			wantNil: true,
		},
		{
			name:    "p99 improved (faster) → no signal — this is good news, not a regression",
			curr:    agg(100, 0, 500, 0),
			prior:   agg(100, 0, 1000, 0),
			wantNil: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectP99Regression(tt.curr, tt.prior)
			if tt.wantNil {
				if got != nil {
					t.Errorf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("expected regression, got nil")
			}
			if got.Severity != tt.wantSev {
				t.Errorf("severity: got %s, want %s", got.Severity, tt.wantSev)
			}
			if got.Kind != RegressionLatencyP99 {
				t.Errorf("kind: got %s, want %s", got.Kind, RegressionLatencyP99)
			}
		})
	}
}

func TestDetectErrorRateRegression(t *testing.T) {
	tests := []struct {
		name    string
		curr    aggregate
		prior   aggregate
		wantNil bool
		wantSev RegressionSeverity
	}{
		{
			name:    "below minCalls → no signal",
			curr:    agg(10, 0, 0, 5.0),
			prior:   agg(10, 0, 0, 0.5),
			wantNil: true,
		},
		{
			name:    "current error rate below floor → no signal",
			curr:    agg(100, 0, 0, 1.5), // below errorRateMinCurrentPct (2.0)
			prior:   agg(100, 0, 0, 0.1),
			wantNil: true,
		},
		{
			name:    "+2pp exactly, current=2% → watch",
			curr:    agg(100, 0, 0, 2.0),
			prior:   agg(100, 0, 0, 0.0),
			wantSev: SeverityWatch,
		},
		{
			name:    "+5pp absolute, current ≥5% → critical",
			curr:    agg(100, 0, 0, 5.5),
			prior:   agg(100, 0, 0, 0.5),
			wantSev: SeverityCritical,
		},
		{
			name:    "+1.9pp delta → no signal (below abs threshold)",
			curr:    agg(100, 0, 0, 2.5),
			prior:   agg(100, 0, 0, 0.7), // diff = 1.8
			wantNil: true,
		},
		{
			name:    "error rate dropped → no signal (improvement, not regression)",
			curr:    agg(100, 0, 0, 3.0),
			prior:   agg(100, 0, 0, 10.0),
			wantNil: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectErrorRateRegression(tt.curr, tt.prior)
			if tt.wantNil {
				if got != nil {
					t.Errorf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("expected regression, got nil")
			}
			if got.Severity != tt.wantSev {
				t.Errorf("severity: got %s, want %s", got.Severity, tt.wantSev)
			}
		})
	}
}

func TestDetectCostRegression(t *testing.T) {
	tests := []struct {
		name    string
		curr    aggregate
		prior   aggregate
		wantNil bool
		wantSev RegressionSeverity
	}{
		{
			name:    "current cost below floor → no signal",
			curr:    agg(100, 0.5, 0, 0), // below costMinCurrentUSD (1.0)
			prior:   agg(100, 0.2, 0, 0),
			wantNil: true,
		},
		{
			name:    "prior cost zero → no signal (would be infinite-pct; covered by 'new' insight)",
			curr:    agg(100, 5, 0, 0),
			prior:   agg(100, 0, 0, 0),
			wantNil: true,
		},
		{
			name:    "+30% exactly, +$1 delta → watch",
			curr:    agg(100, 13.0, 0, 0),
			prior:   agg(100, 10.0, 0, 0), // pct = 30, delta = 3
			wantSev: SeverityWatch,
		},
		{
			name:    "doubled → critical",
			curr:    agg(100, 20.0, 0, 0),
			prior:   agg(100, 10.0, 0, 0),
			wantSev: SeverityCritical,
		},
		{
			// Specifically exercises the DELTA floor — the pct check passes
			// (+31.25%) but the absolute delta ($0.25) is below the $1 floor.
			// This is the case the original test claimed to cover but didn't:
			// it picked numbers that fell short on pct first, so the delta
			// floor was never actually exercised.
			name:    "+31% but $0.25 delta → no signal (delta floor catches it)",
			curr:    agg(100, 1.05, 0, 0),
			prior:   agg(100, 0.80, 0, 0), // pct = 31.25%, delta = 0.25
			wantNil: true,
		},
		{
			name:    "+25% → no signal (below pct threshold)",
			curr:    agg(100, 12.5, 0, 0),
			prior:   agg(100, 10.0, 0, 0),
			wantNil: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectCostRegression(tt.curr, tt.prior)
			if tt.wantNil {
				if got != nil {
					t.Errorf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("expected regression, got nil")
			}
			if got.Severity != tt.wantSev {
				t.Errorf("severity: got %s, want %s", got.Severity, tt.wantSev)
			}
		})
	}
}

func TestDetectVolumeDrop(t *testing.T) {
	tests := []struct {
		name    string
		curr    aggregate
		prior   aggregate
		wantNil bool
	}{
		{
			name:    "prior below minimum (was never busy) → no signal",
			curr:    agg(0, 0, 0, 0),
			prior:   agg(100, 0, 0, 0), // below volumeDropMinPriorCalls (200)
			wantNil: true,
		},
		{
			name:    "current calls grew → no signal",
			curr:    agg(500, 0, 0, 0),
			prior:   agg(300, 0, 0, 0),
			wantNil: true,
		},
		{
			name:    "-50% exactly → watch (the rule's only severity)",
			curr:    agg(100, 0, 0, 0),
			prior:   agg(200, 0, 0, 0),
			wantNil: false,
		},
		{
			name:    "-90% → still watch (no critical tier for volume drop)",
			curr:    agg(20, 0, 0, 0),
			prior:   agg(200, 0, 0, 0),
			wantNil: false,
		},
		{
			name:    "-30% → no signal (above threshold)",
			curr:    agg(150, 0, 0, 0),
			prior:   agg(220, 0, 0, 0),
			wantNil: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectVolumeDrop(tt.curr, tt.prior)
			if tt.wantNil {
				if got != nil {
					t.Errorf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("expected regression, got nil")
			}
			if got.Kind != RegressionVolumeDrop {
				t.Errorf("kind: got %s, want %s", got.Kind, RegressionVolumeDrop)
			}
			// Volume drop is always SeverityWatch — there's no critical tier
			// because we can't distinguish "broken" from "off-hours" cheaply.
			if got.Severity != SeverityWatch {
				t.Errorf("expected watch, got %s", got.Severity)
			}
		})
	}
}
