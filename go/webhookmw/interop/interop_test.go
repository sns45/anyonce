// Package interop_test signs with anyhook and receives with anyonce (REQ-WH-6). It is a nested module with its own
// go.mod so that github.com/sns45/anyonce/go keeps the dependency set CLAUDE.md names: the standard library, the
// store clients and modernc.org/sqlite. anyonce imports nothing from anyhook at runtime; this is a test only edge.
package interop_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyhook/go/signing"
	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/standardwebhooks"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/webhookmw"
)

// deliver builds an anyhook signed request for the given secret, id and payload.
func deliver(t *testing.T, secret, id, payload string) *http.Request {
	t.Helper()
	headers, err := signing.NewSigner(secret).Headers(id, payload, time.Now())
	if err != nil {
		t.Fatalf("Headers: %v", err)
	}
	r := httptest.NewRequest(http.MethodPost, "https://example.test/hooks/anyhook", strings.NewReader(payload))
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestAnyhookInterop(t *testing.T) {
	t.Run("REQ-WH-6: a delivery signed by anyhook is accepted, and the redelivery replays", func(t *testing.T) {
		secret, err := signing.GenerateSecret(24)
		if err != nil {
			t.Fatalf("GenerateSecret: %v", err)
		}
		verifier, err := standardwebhooks.New(secret)
		if err != nil {
			t.Fatalf("standardwebhooks.New: %v", err)
		}
		var runs int
		mw := webhookmw.New(memory.New(), webhookmw.Options{Verify: verifier.VerifyFunc()})
		h := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			runs++
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"received":true}`))
		}))

		first := httptest.NewRecorder()
		h.ServeHTTP(first, deliver(t, secret, "msg_interop_1", `{"event":"payment.succeeded"}`))
		if first.Code != http.StatusOK {
			t.Fatalf("first: status = %d, want 200", first.Code)
		}
		if first.Header().Get("Idempotency-Replayed") != "" {
			t.Fatal("the first delivery claims to be a replay")
		}

		second := httptest.NewRecorder()
		h.ServeHTTP(second, deliver(t, secret, "msg_interop_1", `{"event":"payment.succeeded"}`))
		if second.Code != http.StatusOK {
			t.Fatalf("second: status = %d, want 200", second.Code)
		}
		if second.Header().Get("Idempotency-Replayed") != "true" {
			t.Fatal("the redelivery did not report a replay")
		}
		if second.Body.String() != `{"received":true}` {
			t.Fatalf("second: body = %q", second.Body.String())
		}
		if runs != 1 {
			t.Fatalf("handler ran %d times, want 1", runs)
		}
	})

	t.Run("REQ-WH-6: a delivery signed with a different secret is 401 and never runs the handler", func(t *testing.T) {
		receiverSecret, err := signing.GenerateSecret(24)
		if err != nil {
			t.Fatalf("GenerateSecret: %v", err)
		}
		signerSecret, err := signing.GenerateSecret(24)
		if err != nil {
			t.Fatalf("GenerateSecret: %v", err)
		}
		verifier, err := standardwebhooks.New(receiverSecret)
		if err != nil {
			t.Fatalf("standardwebhooks.New: %v", err)
		}
		var runs int
		mw := webhookmw.New(memory.New(), webhookmw.Options{Verify: verifier.VerifyFunc()})
		h := mw.Handler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { runs++ }))

		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, deliver(t, signerSecret, "msg_interop_2", `{"a":1}`))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeSignatureInvalid {
			t.Fatalf("code = %q, want signature-invalid", p.Code)
		}
		if runs != 0 {
			t.Fatalf("handler ran %d times, want 0", runs)
		}
	})

	t.Run("REQ-WH-6: a rotation signature from anyhook verifies against either secret the receiver holds", func(t *testing.T) {
		older, err := signing.GenerateSecret(24)
		if err != nil {
			t.Fatalf("GenerateSecret: %v", err)
		}
		newer, err := signing.GenerateSecret(24)
		if err != nil {
			t.Fatalf("GenerateSecret: %v", err)
		}
		payload := `{"event":"rotated"}`
		headers, err := signing.NewSigner(older, newer).Headers("msg_interop_3", payload, time.Now())
		if err != nil {
			t.Fatalf("Headers: %v", err)
		}
		r := httptest.NewRequest(http.MethodPost, "https://example.test/hooks/anyhook", strings.NewReader(payload))
		for name, value := range headers {
			r.Header.Set(name, value)
		}

		verifier, err := standardwebhooks.New(newer)
		if err != nil {
			t.Fatalf("standardwebhooks.New: %v", err)
		}
		if err := verifier.Verify(r.Header, []byte(payload)); err != nil {
			t.Fatalf("Verify: %v", err)
		}
	})

	t.Run("REQ-WH-5: a tampered body under a signed id that already landed is 422 and fires OnSuspicious", func(t *testing.T) {
		secret, err := signing.GenerateSecret(24)
		if err != nil {
			t.Fatalf("GenerateSecret: %v", err)
		}
		verifier, err := standardwebhooks.New(secret)
		if err != nil {
			t.Fatalf("standardwebhooks.New: %v", err)
		}
		var suspicious []*anyonce.Record
		mw := webhookmw.New(memory.New(), webhookmw.Options{
			Verify: verifier.VerifyFunc(),
			OnSuspicious: func(_ *http.Request, rec *anyonce.Record) {
				suspicious = append(suspicious, rec)
			},
		})
		h := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("handled"))
		}))

		// The tampered delivery below is signed correctly, with the same secret and the same id, over its own
		// tampered body. It passes verification and is caught only by the fingerprint check (REQ-WH-5); a bad
		// signature here would prove nothing about the attack this REQ exists for.
		h.ServeHTTP(httptest.NewRecorder(), deliver(t, secret, "msg_interop_4", `{"amount":10}`))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, deliver(t, secret, "msg_interop_4", `{"amount":9000}`))

		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeFingerprintMismatch {
			t.Fatalf("code = %q, want fingerprint-mismatch", p.Code)
		}
		if len(suspicious) != 1 {
			t.Fatalf("OnSuspicious fired %d times, want 1", len(suspicious))
		}
		if suspicious[0].Key != "msg_interop_4" {
			t.Fatalf("key = %q, want msg_interop_4", suspicious[0].Key)
		}
	})
}
