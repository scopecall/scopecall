package query

import "testing"

// quotedINList builds a comma-separated, single-quote-wrapped list of values
// for ClickHouse IN clauses. The function is in a SQL-construction hot path
// and the safety property (single-quote doubling) prevents injection from any
// caller — span_ids and parent_span_ids come from ingest-side SDK input.
func TestQuotedINList(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want string
	}{
		{name: "empty", in: nil, want: ""},
		{name: "single", in: []string{"abc"}, want: "'abc'"},
		{name: "two", in: []string{"abc", "def"}, want: "'abc','def'"},
		{
			// Critical safety property: any single quote in a value MUST be
			// doubled so it doesn't break out of the SQL string literal.
			// If a future contributor removes the ReplaceAll, this test fails.
			name: "single quote escaped by doubling",
			in:   []string{"o'brien"},
			want: "'o''brien'",
		},
		{
			name: "multiple single quotes all escaped",
			in:   []string{"'", "''"},
			want: "''''" + "," + "''''''",
		},
		{
			// SECURITY: ClickHouse string literals accept `\'` as an escape.
			// Without doubling backslashes BEFORE single quotes, a value
			// ending in `\` would let an attacker break out of the literal
			// (see B1 from the second-pass security review). This test locks
			// the property: if someone removes the `\\` ReplaceAll, the
			// trailing backslash leaks through and this expectation fails.
			name: "trailing backslash escaped (was B1 from review)",
			in:   []string{`x\`},
			want: `'x\\'`,
		},
		{
			// The exploit shape: a value designed to break out of the string
			// literal and inject a second IN-list term. After our fix, the
			// backslash is doubled BEFORE the quote is doubled, so neither
			// escape mechanism gives the attacker a way out.
			name: "injection attempt with backslash + quote",
			in:   []string{`x\','BREAKOUT`},
			want: `'x\\'',''BREAKOUT'`,
		},
		{
			// Two backslashes in a row should become four.
			name: "embedded backslash sequence",
			in:   []string{`a\b\c`},
			want: `'a\\b\\c'`,
		},
		{
			// Dedup: callers pass span_ids + parent_span_ids which can overlap
			// (a chain-of-children scenario). The function dedupes — verifies
			// we don't spam the SQL with redundant terms.
			name: "duplicate values deduped, first occurrence wins",
			in:   []string{"abc", "abc", "def", "abc"},
			want: "'abc','def'",
		},
		{
			// Whitespace and special chars (non-quote) pass through as-is —
			// ClickHouse can handle them inside string literals.
			name: "whitespace and dashes pass through",
			in:   []string{"span-123", "span 456"},
			want: "'span-123','span 456'",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := quotedINList(tt.in)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
