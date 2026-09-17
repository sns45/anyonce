package httpmw_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/memory"
)

func TestConformance(t *testing.T) {
	t.Run("REQ-HTTP-18: every core and profile vector passes through httpmw with the memory store", func(t *testing.T) {
		f := fixture.New()
		mw := httpmw.New(memory.New(), httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		summary := conformance.Run(t, mux, conformance.Options{Capabilities: []string{"short-ttl"}})
		if summary.Passed != len(summary.Results) || len(summary.Results) != 20 {
			t.Fatalf("passed %d of %d: %+v", summary.Passed, len(summary.Results), summary.Results)
		}
	})
}
