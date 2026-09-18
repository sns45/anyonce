package webhookmw_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/webhookmw"
)

func TestConformance(t *testing.T) {
	t.Run("REQ-WH-7: every core and profile vector passes through webhookmw with the memory store", func(t *testing.T) {
		f := fixture.New()
		required := true
		mw := webhookmw.New(memory.New(), webhookmw.Options{
			// Q28: the vectors carry the HTTP door's header and no signature, and the gate has its own tests.
			IDHeader: "Idempotency-Key",
			Verify:   func(*http.Request, []byte) (bool, error) { return true, nil },
			Required: &required,
			// The vectors assert the HTTP door's fingerprint, so the harness asks for it explicitly.
			Fingerprint: func(r *http.Request, body []byte) (string, error) {
				return anyonce.HTTPFingerprint(r.Method, r.URL.RequestURI(), body), nil
			},
			RoutePattern: "",
			Policy:       anyonce.Policy{TTL: 2 * time.Second},
		})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		summary := conformance.Run(t, mux, conformance.Options{Capabilities: []string{"short-ttl"}})
		if summary.Passed != len(summary.Results) || len(summary.Results) != 20 {
			t.Fatalf("passed %d of %d: %+v", summary.Passed, len(summary.Results), summary.Results)
		}
	})
}
