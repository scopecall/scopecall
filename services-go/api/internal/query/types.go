package query

import "time"

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
