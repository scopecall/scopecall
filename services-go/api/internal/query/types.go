package query

import (
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type TimeWindow struct {
	From time.Time
	To   time.Time
}

// ClickHouse server-side query parameters ({name:Type}) are transmitted to the
// server as strings; the server then casts each value per its :Type annotation.
// time.Time values must therefore be pre-formatted as text. We anchor to UTC and
// pair these with DateTime('UTC') / DateTime64(_, 'UTC') type annotations so that
// comparisons against the UTC-typed timestamp column are correct regardless of
// the ClickHouse server's configured timezone.
const (
	chDateTimeLayout   = "2006-01-02 15:04:05"
	chDateTime64Layout = "2006-01-02 15:04:05.000000000"
)

// chDateTime formats t for a {name:DateTime('UTC')} query parameter.
func chDateTime(t time.Time) string {
	return t.UTC().Format(chDateTimeLayout)
}

// chDateTime64 formats t (nanosecond precision) for a {name:DateTime64(9,'UTC')} query parameter.
func chDateTime64(t time.Time) string {
	return t.UTC().Format(chDateTime64Layout)
}

// Scope narrows a query to one environment and/or project. The zero value
// applies no narrowing (org-wide). Empty fields are skipped, so the API can't
// filter FOR the unassigned ('') project — deliberate: the dashboard's picker
// is fed by Projects(), which only lists non-empty labels.
type Scope struct {
	Environment string
	Project     string
}

// cond returns the scope's AND-clauses with the given column prefix ("" or
// "l."), bound to scope_env / scope_project named parameters. Append to any
// WHERE block whose query then passes params() output.
func (s Scope) cond(prefix string) string {
	var b strings.Builder
	if s.Environment != "" {
		b.WriteString("\n  AND " + prefix + "environment = {scope_env:String}")
	}
	if s.Project != "" {
		b.WriteString("\n  AND " + prefix + "project = {scope_project:String}")
	}
	return b.String()
}

// params appends the scope's bound values to args.
func (s Scope) params(args []driver.NamedValue) []driver.NamedValue {
	if s.Environment != "" {
		args = append(args, driver.NamedValue{Name: "scope_env", Value: s.Environment})
	}
	if s.Project != "" {
		args = append(args, driver.NamedValue{Name: "scope_project", Value: s.Project})
	}
	return args
}
