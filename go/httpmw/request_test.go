package httpmw

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

// The helpers that moved to internal/httpx are proved there. What stays here is the part that reads Options.
func TestRequestHelpers(t *testing.T) {
	t.Run("REQ-HTTP-5: the default scope is METHOD and path, a Scope option wins, a principal is appended", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/orders/42?x=1", nil)
		if scope, ok := resolveScope(r, (Options{}).resolve()); !ok || scope != "POST /orders/42" {
			t.Fatalf("%q %v", scope, ok)
		}
		if scope, ok := resolveScope(r, (Options{Scope: func(*http.Request) string { return "custom" }}).resolve()); !ok || scope != "custom" {
			t.Fatalf("%q %v", scope, ok)
		}
		principal := func(r *http.Request) string { return r.Header.Get("X-Tenant") }
		r.Header.Set("X-Tenant", "acme")
		if scope, ok := resolveScope(r, (Options{Principal: principal}).resolve()); !ok || scope != "POST /orders/42#acme" {
			t.Fatalf("%q %v", scope, ok)
		}
		r.Header.Del("X-Tenant")
		if scope, ok := resolveScope(r, (Options{Principal: principal}).resolve()); !ok || scope != "POST /orders/42" {
			t.Fatalf("%q %v", scope, ok)
		}
		if _, ok := resolveScope(r, (Options{Principal: principal, RequirePrincipal: true}).resolve()); ok {
			t.Fatal("expected missing principal")
		}
	})
	t.Run("REQ-HTTP-6: body mode hashes method, path with query and bytes; jcs mode equates reordered JSON and falls back", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/p?x=1", nil)
		if got, _ := fingerprint(r, []byte("abc"), (Options{}).resolve()); got != anyonce.HTTPFingerprint("POST", "/p?x=1", []byte("abc")) {
			t.Fatal(got)
		}
		jcs := (Options{Fingerprint: FingerprintJCS}).resolve()
		a, _ := fingerprint(r, []byte(`{"a":1,"b":[1,2]}`), jcs)
		b, _ := fingerprint(r, []byte(` { "b" : [1, 2], "a" : 1 } `), jcs)
		if a != b || a != anyonce.SHA256Hex([]byte("POST\n/p?x=1\n{\"a\":1,\"b\":[1,2]}")) {
			t.Fatalf("%s %s", a, b)
		}
		if got, _ := fingerprint(r, []byte("not json"), jcs); got != anyonce.HTTPFingerprint("POST", "/p?x=1", []byte("not json")) {
			t.Fatal(got)
		}
		custom := (Options{FingerprintFunc: func(r *http.Request, body []byte) (string, error) {
			return r.Header.Get("X-V") + ":" + string(body), nil
		}}).resolve()
		r.Header.Set("X-V", "2")
		if got, _ := fingerprint(r, []byte("abc"), custom); got != "2:abc" {
			t.Fatal(got)
		}
	})
}
