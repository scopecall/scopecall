package alerts

import "testing"

// isValidSlackWebhook gates which URLs the evaluator will POST to. Without
// this guard, an owner-controlled webhook_url becomes an SSRF primitive into
// internal infrastructure (k8s API, cloud metadata IMDS, internal Redis).
// Every entry in this table is a real-world bypass attempt to keep out.
func TestIsValidSlackWebhook(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want bool
	}{
		// ── happy path ──
		{name: "canonical incoming webhook", url: "https://hooks.slack.com/services/T0/B0/abcdef", want: true},
		{name: "slack.com legacy host", url: "https://slack.com/api/something", want: true},
		{name: "subpath doesn't matter", url: "https://hooks.slack.com/anything/here", want: true},
		{name: "host case-insensitive", url: "https://HOOKS.SLACK.COM/services/x", want: true},

		// ── scheme attacks ──
		{name: "plain http rejected (internal-network probe)", url: "http://hooks.slack.com/x", want: false},
		{name: "file:// rejected", url: "file:///etc/passwd", want: false},
		{name: "gopher:// rejected (classic SSRF vector)", url: "gopher://internal.svc:6379/", want: false},
		{name: "empty string rejected", url: "", want: false},
		{name: "no scheme rejected", url: "hooks.slack.com/x", want: false},

		// ── host attacks ──
		{name: "ip literal rejected", url: "https://169.254.169.254/latest/meta-data", want: false},
		{name: "localhost rejected", url: "https://localhost:6379/", want: false},
		{name: "private ip rejected", url: "https://10.0.0.1/", want: false},
		{name: "lookalike domain rejected", url: "https://hooks.slack.com.attacker.com/x", want: false},
		{name: "prefix attack rejected", url: "https://attacker-hooks.slack.com/x", want: false},
		{name: "userinfo attack rejected", url: "https://hooks.slack.com@attacker.com/x", want: false},

		// ── malformed input ──
		{name: "garbage rejected", url: "not a url at all", want: false},
		{name: "spaces in URL rejected", url: "https://hooks.slack.com /x", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isValidSlackWebhook(tt.url)
			if got != tt.want {
				t.Errorf("isValidSlackWebhook(%q) = %v, want %v", tt.url, got, tt.want)
			}
		})
	}
}
