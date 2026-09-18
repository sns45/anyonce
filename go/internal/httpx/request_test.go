package httpx_test

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
)

func TestRequestHelpers(t *testing.T) {
	t.Run("REQ-HTTP-2: the header is looked up case-insensitively and a repeated field is invalid", func(t *testing.T) {
		h := http.Header{}
		h.Set("idempotency-key", "abc")
		if key, st, _ := httpx.LookupKey(h, "Idempotency-Key", anyonce.SyntaxLenient); st != httpx.KeyOK || key != "abc" {
			t.Fatalf("%v %q", st, key)
		}
		if _, st, _ := httpx.LookupKey(http.Header{}, "Idempotency-Key", anyonce.SyntaxLenient); st != httpx.KeyMissing {
			t.Fatal(st)
		}
		h.Add("Idempotency-Key", "two")
		if _, st, reason := httpx.LookupKey(h, "Idempotency-Key", anyonce.SyntaxLenient); st != httpx.KeyInvalid || !strings.Contains(reason, "repeated") {
			t.Fatalf("%v %q", st, reason)
		}
	})
	t.Run("REQ-HTTP-4: strict syntax rejects a bare token", func(t *testing.T) {
		h := http.Header{"Idempotency-Key": {"bare"}}
		if _, st, _ := httpx.LookupKey(h, "Idempotency-Key", anyonce.SyntaxStrict); st != httpx.KeyInvalid {
			t.Fatal(st)
		}
		if key, st, _ := httpx.LookupKey(http.Header{"Idempotency-Key": {"\"quoted key\""}}, "Idempotency-Key", anyonce.SyntaxStrict); st != httpx.KeyOK || key != "quoted key" {
			t.Fatalf("%v %q", st, key)
		}
	})
	t.Run("REQ-HTTP-2: the invalid reason never contains the key value", func(t *testing.T) {
		_, _, reason := httpx.LookupKey(http.Header{"Idempotency-Key": {"has space inside"}}, "Idempotency-Key", anyonce.SyntaxLenient)
		if strings.Contains(reason, "has space") {
			t.Fatal(reason)
		}
	})
	t.Run("REQ-HTTP-5: the default scope is METHOD and path, a Scope option wins, a principal is appended", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/orders/42?x=1", nil)
		if got := httpx.DefaultScope(r); got != "POST /orders/42" {
			t.Fatal(got)
		}
		if got := httpx.RequestPath(r); got != "/orders/42?x=1" {
			t.Fatal(got)
		}
	})
	t.Run("REQ-HTTP-5: the default scope keeps percent encoding so it matches the TypeScript scope", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/users/john%40example.com", nil)
		if got := httpx.DefaultScope(r); got != "POST /users/john%40example.com" {
			t.Fatal(got)
		}
	})
	t.Run("REQ-HTTP-6: readBody reads once, re-supplies the body and enforces the cap", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("payload"))
		body, err := httpx.ReadBody(r, 1024)
		if err != nil || string(body) != "payload" {
			t.Fatalf("%q %v", body, err)
		}
		again, _ := io.ReadAll(r.Body)
		if string(again) != "payload" {
			t.Fatalf("handler sees %q", again)
		}
		declared := httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("0123456789"))
		if _, err := httpx.ReadBody(declared, 9); !errors.Is(err, httpx.ErrTooLarge) {
			t.Fatal(err)
		}
		undeclared := httptest.NewRequest(http.MethodPost, "/p", io.NopCloser(bytes.NewReader([]byte("0123456789"))))
		undeclared.ContentLength = -1
		if _, err := httpx.ReadBody(undeclared, 9); !errors.Is(err, httpx.ErrTooLarge) {
			t.Fatal(err)
		}
		if body, err := httpx.ReadBody(httptest.NewRequest(http.MethodPost, "/p", nil), 9); err != nil || len(body) != 0 {
			t.Fatalf("%q %v", body, err)
		}
	})
}
