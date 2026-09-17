package httpmw

import (
	"net/http"
	"testing"
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
}
