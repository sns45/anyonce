package conformance

import (
	"net/http"
	"testing"
)

func str(s string) *string { return &s }
func num(n int) *int       { return &n }

func TestEvaluate(t *testing.T) {
	obs := observed{status: 201, header: http.Header{"Content-Type": {"text/plain"}, "Idempotency-Replayed": {"true"}}, body: []byte("hello")}
	t.Run("REQ-CONF-6: an exact match yields no failures", func(t *testing.T) {
		exp := StepExpect{Status: 201, Headers: map[string]HeaderExpectation{"content-type": {Exact: str("text/plain")}, "Idempotency-Replayed": {Present: true}, "Retry-After": {Absent: true}}, BodyEquals: &BodyEquals{Exact: str("hello")}, BodyBytes: num(5)}
		if got := evaluate(exp, obs, evalContext{}); len(got) != 0 {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CONF-6: failure messages mirror the TypeScript runner", func(t *testing.T) {
		one := 1
		exp := StepExpect{Status: 200, Headers: map[string]HeaderExpectation{"Retry-After": {Regex: "^[1-9]"}, "Idempotency-Replayed": {Absent: true}, "X-Missing": {Exact: str("v")}}, BodyEquals: &BodyEquals{SameAs: "first"}, BodyBytes: num(3), HandlerInvocations: &one}
		got := evaluate(exp, obs, evalContext{prior: map[string][]byte{"first": []byte("other")}, invocations: num(2)})
		want := map[string]bool{
			"status: expected 200, got 201":                                              true,
			"header Retry-After: expected /^[1-9]/, got absent":                          true,
			"header Idempotency-Replayed: expected absent, got \"true\"":                 true,
			"header X-Missing: expected \"v\", got absent":                               true,
			"body: expected same bytes as step first (5 bytes), got 5 bytes that differ": true,
			"body: expected 3 bytes, got 5":                                              true,
			"handlerInvocations: expected 1, got 2":                                      true,
		}
		if len(got) != len(want) {
			t.Fatalf("%v", got)
		}
		for _, g := range got {
			if !want[g] {
				t.Fatalf("unexpected %q in %v", g, got)
			}
		}
		if got := evaluate(StepExpect{Status: 201, HandlerInvocations: &one}, obs, evalContext{}); len(got) != 1 || got[0] != "handlerInvocations: counter unavailable" {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CONF-6: bodyJson compares members of a JSON object", func(t *testing.T) {
		json := observed{status: 200, header: http.Header{}, body: []byte(`{"count":1,"code":"x"}`)}
		if got := evaluate(StepExpect{Status: 200, BodyJSON: map[string]any{"count": float64(1), "code": "x"}}, json, evalContext{}); len(got) != 0 {
			t.Fatal(got)
		}
		if got := evaluate(StepExpect{Status: 200, BodyJSON: map[string]any{"count": float64(0)}}, json, evalContext{}); len(got) != 1 || got[0] != "body.count: expected 0, got 1" {
			t.Fatal(got)
		}
		if got := evaluate(StepExpect{Status: 201, BodyJSON: map[string]any{"a": float64(1)}}, obs, evalContext{}); len(got) != 1 || got[0] != "body: expected JSON object, got unparseable body" {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CONF-6: bodyJson reports a missing key as undefined, matching the TypeScript message", func(t *testing.T) {
		json := observed{status: 200, header: http.Header{}, body: []byte(`{"count":1}`)}
		got := evaluate(StepExpect{Status: 200, BodyJSON: map[string]any{"missing": "x"}}, json, evalContext{})
		if len(got) != 1 || got[0] != `body.missing: expected "x", got undefined` {
			t.Fatal(got)
		}
	})
}
