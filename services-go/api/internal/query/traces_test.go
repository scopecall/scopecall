package query

import (
	"strings"
	"testing"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// hierarchyFilterClauses is the SQL-shape contract for the v0.3
// workflow/agent/step filters. The semantic difference between the three
// is the whole point of v0.3 cost attribution — getting it wrong means
// clicking an agent's row in the dashboard shows LLM calls from completely
// unrelated agents in the same trace.
//
// These tests pin down the three contracts:
//   workflow → trace-level   (trace_id IN ...)
//   step     → direct-parent (parent_span_id IN step.span_id)
//   agent    → ancestor      (parent_span_id IN agent.span_id ∪ step-under-agent.span_id)
//
// They run without ClickHouse — the goal is to catch regressions in the
// SQL shape, not to prove end-to-end correctness against real data
// (live verification covers that).

func TestHierarchyFilterClauses_EmptyArgs(t *testing.T) {
	conds, qa := hierarchyFilterClauses(ListTracesArgs{})
	if len(conds) != 0 {
		t.Errorf("expected no conds for empty args, got %d: %v", len(conds), conds)
	}
	if len(qa) != 0 {
		t.Errorf("expected no named args for empty args, got %d", len(qa))
	}
}

func TestHierarchyFilterClauses_WorkflowIsTraceLevel(t *testing.T) {
	conds, qa := hierarchyFilterClauses(ListTracesArgs{Workflow: "support_refund"})
	if len(conds) != 1 {
		t.Fatalf("expected 1 cond, got %d", len(conds))
	}
	sql := conds[0]

	// Workflow must use trace_id IN — the workflow span is at the root of the
	// trace, so "every span in any trace containing this workflow" is the
	// right semantic. (Anything narrower would miss children of the workflow.)
	if !strings.Contains(sql, "trace_id IN") {
		t.Errorf("workflow filter must use trace_id IN; got:\n%s", sql)
	}
	if strings.Contains(sql, "parent_span_id IN") {
		t.Errorf("workflow filter must NOT use parent_span_id IN; got:\n%s", sql)
	}
	if !strings.Contains(sql, "kind = 'workflow'") {
		t.Errorf("workflow filter must match kind='workflow'; got:\n%s", sql)
	}
	if !hasNamedArg(qa, "wf_name", "support_refund") {
		t.Errorf("expected wf_name bound to 'support_refund'; got %+v", qa)
	}
}

func TestHierarchyFilterClauses_StepIsDirectParent(t *testing.T) {
	conds, qa := hierarchyFilterClauses(ListTracesArgs{Step: "classify_intent"})
	if len(conds) != 1 {
		t.Fatalf("expected 1 cond, got %d", len(conds))
	}
	sql := conds[0]

	// Step must use parent_span_id IN — a step is the direct parent of its
	// LLM calls. The wrong shape is trace_id IN: it would return every
	// LLM call in any trace that contains a step with that name, not just
	// the LLM calls actually under that step. This test pins the right
	// semantic so the bug can't sneak back in.
	if !strings.Contains(sql, "parent_span_id IN") {
		t.Errorf("step filter must use parent_span_id IN; got:\n%s", sql)
	}
	if strings.Contains(sql, "trace_id IN") {
		t.Errorf("step filter must NOT use trace_id IN — that would over-select to the whole trace; got:\n%s", sql)
	}
	if !strings.Contains(sql, "kind = 'step'") {
		t.Errorf("step filter must match kind='step'; got:\n%s", sql)
	}
	if !hasNamedArg(qa, "st_name", "classify_intent") {
		t.Errorf("expected st_name bound to 'classify_intent'; got %+v", qa)
	}
}

func TestHierarchyFilterClauses_AgentSpansBothAncestorPaths(t *testing.T) {
	conds, qa := hierarchyFilterClauses(ListTracesArgs{Agent: "policy_check"})
	if len(conds) != 1 {
		t.Fatalf("expected 1 cond, got %d", len(conds))
	}
	sql := conds[0]

	// Agent must use parent_span_id IN — never trace_id IN, which would
	// over-select to the whole trace.
	if !strings.Contains(sql, "parent_span_id IN") {
		t.Errorf("agent filter must use parent_span_id IN; got:\n%s", sql)
	}
	if strings.Contains(sql, "trace_id IN") {
		t.Errorf("agent filter must NOT use trace_id IN — that would over-select to the whole trace; got:\n%s", sql)
	}

	// Both ancestor paths must be covered: direct (workflow → agent → llm)
	// AND via-step (workflow → agent → step → llm). The two halves of the
	// IN-list union together so a single filter clause catches both shapes.
	if !strings.Contains(sql, "UNION ALL") {
		t.Errorf("agent filter must UNION ALL the two ancestor paths; got:\n%s", sql)
	}
	if !strings.Contains(sql, "kind = 'agent'") {
		t.Errorf("agent filter must include kind='agent' arm (direct path); got:\n%s", sql)
	}
	if !strings.Contains(sql, "s.kind = 'step'") || !strings.Contains(sql, "a.kind = 'agent'") {
		t.Errorf("agent filter must include the via-step join (kind='step' joined to kind='agent'); got:\n%s", sql)
	}

	if !hasNamedArg(qa, "ag_name", "policy_check") {
		t.Errorf("expected ag_name bound to 'policy_check'; got %+v", qa)
	}
}

func TestHierarchyFilterClauses_WorkflowPlusAgentCombines(t *testing.T) {
	// Frontend drill-in from the workflow detail page's by-agent panel
	// sends both filters together. They must AND cleanly — and crucially,
	// each must use ITS OWN correct subquery shape, not collapse into a
	// single trace_id check (which would re-introduce the over-selection bug).
	conds, qa := hierarchyFilterClauses(ListTracesArgs{
		Workflow: "support_refund",
		Agent:    "policy_check",
	})
	if len(conds) != 2 {
		t.Fatalf("expected 2 conds for workflow+agent, got %d: %v", len(conds), conds)
	}

	all := strings.Join(conds, " ")
	if !strings.Contains(all, "trace_id IN") || !strings.Contains(all, "parent_span_id IN") {
		t.Errorf("combined filter must use trace_id IN AND parent_span_id IN; got:\n%s", all)
	}
	if !hasNamedArg(qa, "wf_name", "support_refund") {
		t.Errorf("wf_name not bound; got %+v", qa)
	}
	if !hasNamedArg(qa, "ag_name", "policy_check") {
		t.Errorf("ag_name not bound; got %+v", qa)
	}
}

func TestHierarchyFilterClauses_AllThreeCombines(t *testing.T) {
	// Pathological but legal — confirm no collisions between the three.
	conds, qa := hierarchyFilterClauses(ListTracesArgs{
		Workflow: "support_refund",
		Agent:    "policy_check",
		Step:     "lookup_policy",
	})
	if len(conds) != 3 {
		t.Fatalf("expected 3 conds for workflow+agent+step, got %d", len(conds))
	}
	if !hasNamedArg(qa, "wf_name", "support_refund") ||
		!hasNamedArg(qa, "ag_name", "policy_check") ||
		!hasNamedArg(qa, "st_name", "lookup_policy") {
		t.Errorf("expected all three filter params bound; got %+v", qa)
	}
}

func TestHierarchyFilterClauses_TimeBoundsPresent(t *testing.T) {
	// Every subquery must include the (prior-window-safe) time bound. Without
	// it, a long-lived span emitted years before the visible window could
	// drag in a massive unbounded scan. The `- INTERVAL 1 DAY` lookback
	// covers workflow/agent/step spans emitted slightly before the user's
	// chosen range — see comment in the production helper.
	cases := []ListTracesArgs{
		{Workflow: "w"},
		{Agent: "a"},
		{Step: "s"},
	}
	for _, args := range cases {
		conds, _ := hierarchyFilterClauses(args)
		if len(conds) == 0 {
			t.Errorf("expected a cond for args %+v", args)
			continue
		}
		sql := conds[0]
		if !strings.Contains(sql, "INTERVAL 1 DAY") {
			t.Errorf("expected one-day lookback in subquery for %+v; got:\n%s", args, sql)
		}
		if !strings.Contains(sql, "{from:DateTime('UTC')}") ||
			!strings.Contains(sql, "{to:DateTime('UTC')}") {
			t.Errorf("expected from/to bounds in subquery for %+v; got:\n%s", args, sql)
		}
		if !strings.Contains(sql, "org_id = {org_id:String}") {
			t.Errorf("every subquery must be org-scoped; got:\n%s", sql)
		}
	}
}

// hasNamedArg returns true when args contains a driver.NamedValue with the
// given name and value. Tests use this to confirm filter values are bound
// rather than spliced via Sprintf — the SQL-injection-safety contract.
func hasNamedArg(args []driver.NamedValue, name, value string) bool {
	for _, a := range args {
		if a.Name == name {
			if s, ok := a.Value.(string); ok && s == value {
				return true
			}
		}
	}
	return false
}
