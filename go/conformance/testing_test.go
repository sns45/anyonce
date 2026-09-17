package conformance_test

import (
	"net/http/httptest"
	"testing"

	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
)

func TestRun(t *testing.T) {
	t.Run("REQ-CONF-6: Run accepts an http.Handler and a base URL string and reports per vector subtests", func(t *testing.T) {
		summary := conformance.Run(t, fixture.New().Handler(), conformance.Options{Only: []string{"core/post-executes-once"}})
		if summary.Passed != 1 {
			t.Fatalf("%+v", summary)
		}
		srv := httptest.NewServer(fixture.New().Handler())
		defer srv.Close()
		if s := conformance.Run(t, srv.URL, conformance.Options{Only: []string{"core/two-keys-execute-twice"}}); s.Passed != 1 {
			t.Fatalf("%+v", s)
		}
	})
}
