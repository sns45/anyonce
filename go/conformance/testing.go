package conformance

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Run drives the suite from a test (REQ-CONF-6). target is an http.Handler (served by httptest for the run) or a
// base URL string. Each vector becomes a subtest; not-applicable vectors are skipped, failures and errors fail.
func Run(t *testing.T, target any, opts Options) Summary {
	t.Helper()
	var baseURL string
	switch v := target.(type) {
	case http.Handler:
		srv := httptest.NewServer(v)
		t.Cleanup(srv.Close)
		baseURL = srv.URL
	case string:
		baseURL = v
	default:
		t.Fatalf("conformance.Run: target must be an http.Handler or a base URL string, got %T", target)
	}
	dir := opts.VectorsDir
	if dir == "" {
		dir = DefaultVectorsDir()
	}
	vectors, err := LoadVectors(dir)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := RunVectors(context.Background(), baseURL, vectors, opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range summary.Results {
		t.Run(r.ID, func(t *testing.T) {
			switch r.Status {
			case "pass":
			case "not-applicable":
				t.Skip(r.Error)
			default:
				t.Errorf("%s: %s", r.Status, strings.TrimSpace(details(r)))
			}
		})
	}
	return summary
}
