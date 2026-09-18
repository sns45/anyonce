package httpmw

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sns45/anyonce/go/store/memory"
)

func TestOptions(t *testing.T) {
	t.Run("REQ-HTTP-1: the default methods are POST and PATCH and Methods is matched uppercased", func(t *testing.T) {
		r := Options{}.resolve()
		if !r.methods[http.MethodPost] || !r.methods[http.MethodPatch] || r.methods[http.MethodGet] {
			t.Fatalf("methods %v", r.methods)
		}
		if got := (Options{Methods: []string{"put"}}).resolve().methods; !got["PUT"] || got["POST"] {
			t.Fatalf("methods %v", got)
		}
	})
	t.Run("REQ-HTTP-2: the header name defaults to Idempotency-Key", func(t *testing.T) {
		if r := (Options{}).resolve(); r.HeaderName != "Idempotency-Key" {
			t.Fatal(r.HeaderName)
		}
	})
	t.Run("REQ-HTTP-4: key syntax defaults to lenient", func(t *testing.T) {
		if r := (Options{}).resolve(); r.KeySyntax != "lenient" {
			t.Fatal(r.KeySyntax)
		}
	})
	t.Run("REQ-HTTP-6: fingerprint defaults to body and MaxRequestBytes to 1 MiB", func(t *testing.T) {
		r := (Options{}).resolve()
		if r.Fingerprint != FingerprintBody || r.MaxRequestBytes != 1<<20 {
			t.Fatalf("%+v", r.Options)
		}
	})
	t.Run("REQ-HTTP-8: the store header allowlist defaults to five canonical names", func(t *testing.T) {
		r := (Options{}).resolve()
		for _, name := range []string{"Content-Type", "Content-Language", "Location", "Etag", "Link"} {
			if !r.storeHeaders[name] {
				t.Fatalf("missing %s in %v", name, r.storeHeaders)
			}
		}
		if got := (Options{StoreHeaders: []string{"x-trace"}}).resolve().storeHeaders; !got["X-Trace"] || got["Content-Type"] {
			t.Fatalf("%v", got)
		}
	})
	t.Run("REQ-HTTP-13: the problem base URI and docs URL have D11 defaults", func(t *testing.T) {
		r := (Options{}).resolve()
		if r.ProblemBaseURI != "https://in8.sh/anyonce/problems/" || r.DocsURL != "https://in8.sh/anyonce/problems/missing-key" {
			t.Fatalf("%+v", r.Options)
		}
		if got := (Options{ProblemBaseURI: "https://p.test/"}).resolve().DocsURL; got != "https://p.test/missing-key" {
			t.Fatal(got)
		}
	})
	// This file is the internal test package, so the exported surface is named without the httpmw qualifier.
	t.Run("REQ-WH-2: ProblemTitles reaches the problem the middleware renders", func(t *testing.T) {
		mw := New(memory.New(), Options{
			Required:      true,
			ProblemTitles: map[Code]string{CodeMissingKey: "The webhook-id header is required for this request"},
		})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/hook", strings.NewReader("x"))
		mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })).ServeHTTP(rec, req)
		if rec.Code != 400 {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		var p Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Title != "The webhook-id header is required for this request" || p.Code != CodeMissingKey {
			t.Fatalf("problem = %+v", p)
		}
	})
}
