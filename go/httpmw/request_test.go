package httpmw

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestRequestHelpers(t *testing.T) {
	t.Run("REQ-HTTP-2: the header is looked up case-insensitively and a repeated field is invalid", func(t *testing.T) {
		h := http.Header{}
		h.Set("idempotency-key", "abc")
		if key, st, _ := lookupKey(h, "Idempotency-Key", anyonce.SyntaxLenient); st != keyOK || key != "abc" {
			t.Fatalf("%v %q", st, key)
		}
		if _, st, _ := lookupKey(http.Header{}, "Idempotency-Key", anyonce.SyntaxLenient); st != keyMissing {
			t.Fatal(st)
		}
		h.Add("Idempotency-Key", "two")
		if _, st, reason := lookupKey(h, "Idempotency-Key", anyonce.SyntaxLenient); st != keyInvalid || !strings.Contains(reason, "repeated") {
			t.Fatalf("%v %q", st, reason)
		}
	})
	t.Run("REQ-HTTP-4: strict syntax rejects a bare token", func(t *testing.T) {
		h := http.Header{"Idempotency-Key": {"bare"}}
		if _, st, _ := lookupKey(h, "Idempotency-Key", anyonce.SyntaxStrict); st != keyInvalid {
			t.Fatal(st)
		}
		if key, st, _ := lookupKey(http.Header{"Idempotency-Key": {"\"quoted key\""}}, "Idempotency-Key", anyonce.SyntaxStrict); st != keyOK || key != "quoted key" {
			t.Fatalf("%v %q", st, key)
		}
	})
	t.Run("REQ-HTTP-2: the invalid reason never contains the key value", func(t *testing.T) {
		_, _, reason := lookupKey(http.Header{"Idempotency-Key": {"has space inside"}}, "Idempotency-Key", anyonce.SyntaxLenient)
		if strings.Contains(reason, "has space") {
			t.Fatal(reason)
		}
	})
	t.Run("REQ-HTTP-5: the default scope is METHOD and path, a Scope option wins, a principal is appended", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/orders/42?x=1", nil)
		if got := defaultScope(r); got != "POST /orders/42" {
			t.Fatal(got)
		}
		if got := requestPath(r); got != "/orders/42?x=1" {
			t.Fatal(got)
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
	t.Run("REQ-HTTP-5: the default scope keeps percent encoding so it matches the TypeScript scope", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/users/john%40example.com", nil)
		if got := defaultScope(r); got != "POST /users/john%40example.com" {
			t.Fatal(got)
		}
	})
	t.Run("REQ-HTTP-6: readBody reads once, re-supplies the body and enforces the cap", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("payload"))
		body, err := readBody(r, 1024)
		if err != nil || string(body) != "payload" {
			t.Fatalf("%q %v", body, err)
		}
		again, _ := io.ReadAll(r.Body)
		if string(again) != "payload" {
			t.Fatalf("handler sees %q", again)
		}
		declared := httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("0123456789"))
		if _, err := readBody(declared, 9); !errors.Is(err, errTooLarge) {
			t.Fatal(err)
		}
		undeclared := httptest.NewRequest(http.MethodPost, "/p", io.NopCloser(bytes.NewReader([]byte("0123456789"))))
		undeclared.ContentLength = -1
		if _, err := readBody(undeclared, 9); !errors.Is(err, errTooLarge) {
			t.Fatal(err)
		}
		if body, err := readBody(httptest.NewRequest(http.MethodPost, "/p", nil), 9); err != nil || len(body) != 0 {
			t.Fatalf("%q %v", body, err)
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
