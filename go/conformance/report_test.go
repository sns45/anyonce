package conformance

import (
	"encoding/json"
	"strings"
	"testing"
)

func sample() Summary {
	return Summary{Results: []VectorResult{
		{ID: "core/post-executes-once", Tier: "core", Status: "pass", Steps: []StepOutcome{{StepID: "first", Failures: []string{}}}},
		{ID: "core/retry-replays", Tier: "core", Status: "fail", Steps: []StepOutcome{{StepID: "first", Failures: []string{}}, {StepID: "retry", Failures: []string{"status: expected 201, got 409", "body: expected \"<a&b>\""}}}},
		{ID: "core/expiry-executes-again", Tier: "core", Status: "not-applicable", Steps: []StepOutcome{}, Error: "requires short-ttl"},
		{ID: "profile/replayed-header", Tier: "profile", Status: "error", Steps: []StepOutcome{}, Error: "reset returned 500"},
	}, Passed: 1, Failed: 1, NotApplicable: 1, Errored: 1}
}

func TestFormat(t *testing.T) {
	t.Run("REQ-CONF-6: json carries the summary with the TypeScript field names and the target", func(t *testing.T) {
		out, err := Format(sample(), "json", "http://x")
		if err != nil {
			t.Fatal(err)
		}
		var parsed map[string]any
		if err := json.Unmarshal(out, &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed["target"] != "http://x" || parsed["notApplicable"] != float64(1) || parsed["results"].([]any)[1].(map[string]any)["steps"].([]any)[1].(map[string]any)["stepId"] != "retry" {
			t.Fatalf("%v", parsed)
		}
	})
	t.Run("REQ-CONF-6: markdown has the summary line and one row per vector", func(t *testing.T) {
		out, _ := Format(sample(), "markdown", "http://x")
		md := string(out)
		for _, want := range []string{"# anyonce conformance report", "Target: http://x", "1 passed, 1 failed, 1 not applicable, 1 errored", "| Vector | Tier | Status | Details |", "| core/post-executes-once | core | pass |  |", "| core/retry-replays | core | fail | retry: status: expected 201, got 409; retry: body: expected \"<a&b>\" |", "| core/expiry-executes-again | core | not-applicable | requires short-ttl |"} {
			if !strings.Contains(md, want) {
				t.Fatalf("missing %q in\n%s", want, md)
			}
		}
	})
	t.Run("REQ-CONF-6: junit has one testcase per vector with escaped messages", func(t *testing.T) {
		out, _ := Format(sample(), "junit", "")
		xml := string(out)
		for _, want := range []string{`<testsuite name="anyonce-conformance" tests="4" failures="1" errors="1" skipped="1">`, `<testcase classname="core" name="core/post-executes-once"/>`, `<failure message="retry: status: expected 201, got 409; retry: body: expected &quot;&lt;a&amp;b&gt;&quot;"/>`, `<skipped message="requires short-ttl"/>`, `<error message="reset returned 500"/>`} {
			if !strings.Contains(xml, want) {
				t.Fatalf("missing %q in\n%s", want, xml)
			}
		}
		if _, err := Format(sample(), "yaml", ""); err == nil {
			t.Fatal("expected an error for an unknown format")
		}
	})
}
