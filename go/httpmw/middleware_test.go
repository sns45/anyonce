package httpmw_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/memory"
)

// capped is a store that declares its own result cap, the anyonce.ResultCapper half of the contract (Q20).
type capped struct {
	anyonce.Store
	limit int
}

func (c capped) MaxResultBytes() int { return c.limit }

type counting struct {
	calls  atomic.Int64
	status int
	header map[string]string
}

func (c *counting) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	n := c.calls.Add(1)
	body, _ := io.ReadAll(r.Body)
	for k, v := range c.header {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "text/plain")
	key, _ := httpmw.KeyFromContext(r.Context())
	fence, _ := httpmw.FenceFromContext(r.Context())
	w.WriteHeader(c.status)
	_, _ = io.WriteString(w, "r"+string(rune('0'+n))+":"+string(body)+":"+key+":"+string(rune('0'+fence)))
}

func post(h http.Handler, path, key, body string, extra map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "text/plain")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func problemCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("content type %q", ct)
	}
	var p struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	return p.Code
}

type failingStore struct{}

func (failingStore) Begin(context.Context, anyonce.Operation, anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	return anyonce.BeginOutcome{}, errors.New("down")
}
func (failingStore) Complete(context.Context, anyonce.Operation, int64, anyonce.StoredResult, time.Time) (anyonce.CompleteStatus, error) {
	return "", errors.New("down")
}
func (failingStore) Abandon(context.Context, anyonce.Operation, int64) (anyonce.CompleteStatus, error) {
	return "", errors.New("down")
}
func (failingStore) Get(context.Context, string, string, time.Time) (*anyonce.Record, error) {
	return nil, errors.New("down")
}
func (failingStore) Purge(context.Context, time.Time) (int, error) { return 0, errors.New("down") }

func TestMiddleware(t *testing.T) {
	t.Run("REQ-HTTP-18: the first request runs, the duplicate replays with Idempotency-Replayed, the handler sees key and fence", func(t *testing.T) {
		c := &counting{status: 201}
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(c)
		first := post(h, "/p", "k", "b", nil)
		if first.Code != 201 || first.Body.String() != "r1:b:k:1" {
			t.Fatalf("%d %q", first.Code, first.Body.String())
		}
		replay := post(h, "/p", "k", "b", nil)
		if replay.Code != 201 || replay.Body.String() != "r1:b:k:1" || replay.Header().Get("Idempotency-Replayed") != "true" || replay.Header().Get("Content-Type") != "text/plain" {
			t.Fatalf("%d %q %v", replay.Code, replay.Body.String(), replay.Header())
		}
		if c.calls.Load() != 1 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-1: GET passes through and a configured method is covered", func(t *testing.T) {
		c := &counting{status: 200}
		h := httpmw.New(memory.New(), httpmw.Options{Methods: []string{"PUT"}}).Handler(c)
		for range 2 {
			req := httptest.NewRequest(http.MethodGet, "/p", nil)
			req.Header.Set("Idempotency-Key", "k")
			h.ServeHTTP(httptest.NewRecorder(), req)
		}
		post(h, "/p", "k", "b", nil)
		post(h, "/p", "k", "b", nil)
		if c.calls.Load() != 4 {
			t.Fatal(c.calls.Load())
		}
		for range 2 {
			req := httptest.NewRequest(http.MethodPut, "/p", strings.NewReader("b"))
			req.Header.Set("Idempotency-Key", "k")
			h.ServeHTTP(httptest.NewRecorder(), req)
		}
		if c.calls.Load() != 5 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-1: methods are matched exactly", func(t *testing.T) {
		c := &counting{status: 201}
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(c)
		for range 2 {
			req := httptest.NewRequest("post", "/p", strings.NewReader("b"))
			req.Header.Set("Idempotency-Key", "k")
			h.ServeHTTP(httptest.NewRecorder(), req)
		}
		if c.calls.Load() != 2 {
			t.Fatalf("a lowercase method must not be matched, calls %d", c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-3: a missing key passes through by default and is 400 missing-key with a Link when required", func(t *testing.T) {
		c := &counting{status: 201}
		if rec := post(httpmw.New(memory.New(), httpmw.Options{}).Handler(c), "/p", "", "b", nil); rec.Code != 201 {
			t.Fatal(rec.Code)
		}
		rec := post(httpmw.New(memory.New(), httpmw.Options{Required: true, DocsURL: "https://d.test/keys"}).Handler(c), "/p", "", "b", nil)
		if rec.Code != 400 || problemCode(t, rec) != "missing-key" || rec.Header().Get("Link") != "<https://d.test/keys>; rel=\"describedby\"" {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
		if c.calls.Load() != 1 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-2: a repeated header is 400 invalid-key", func(t *testing.T) {
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(&counting{status: 201})
		req := httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("b"))
		req.Header.Add("Idempotency-Key", "one")
		req.Header.Add("Idempotency-Key", "two")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 400 || problemCode(t, rec) != "invalid-key" {
			t.Fatal(rec.Code)
		}
	})
	t.Run("REQ-HTTP-5: principals isolate keys and a required missing principal is 500 missing-principal", func(t *testing.T) {
		c := &counting{status: 201}
		h := httpmw.New(memory.New(), httpmw.Options{Principal: func(r *http.Request) string { return r.Header.Get("X-Tenant") }, RequirePrincipal: true}).Handler(c)
		post(h, "/p", "k", "b", map[string]string{"X-Tenant": "a"})
		post(h, "/p", "k", "b", map[string]string{"X-Tenant": "b"})
		if c.calls.Load() != 2 {
			t.Fatal(c.calls.Load())
		}
		if rec := post(h, "/p", "k", "b", nil); rec.Code != 500 || problemCode(t, rec) != "missing-principal" {
			t.Fatal(rec.Code)
		}
	})
	t.Run("REQ-HTTP-5: New panics when RequirePrincipal is set without Principal", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic")
			}
		}()
		httpmw.New(memory.New(), httpmw.Options{RequirePrincipal: true})
	})
	t.Run("REQ-HTTP-6: a body over MaxRequestBytes is 413 and jcs mode equates reordered JSON", func(t *testing.T) {
		c := &counting{status: 201}
		if rec := post(httpmw.New(memory.New(), httpmw.Options{MaxRequestBytes: 4}).Handler(c), "/p", "k", "abcde", nil); rec.Code != 413 || problemCode(t, rec) != "payload-too-large" {
			t.Fatal(rec.Code)
		}
		h := httpmw.New(memory.New(), httpmw.Options{Fingerprint: httpmw.FingerprintJCS}).Handler(c)
		post(h, "/p", "k", `{"a":1,"b":2}`, nil)
		if rec := post(h, "/p", "k", `{"b":2,"a":1}`, nil); rec.Header().Get("Idempotency-Replayed") != "true" {
			t.Fatal("expected replay")
		}
		if c.calls.Load() != 1 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-8: Set-Cookie is never stored and a stored Location replays", func(t *testing.T) {
		store := memory.New()
		c := &counting{status: 202, header: map[string]string{"Set-Cookie": "a=1", "Location": "/orders/1"}}
		h := httpmw.New(store, httpmw.Options{StoreHeaders: []string{"Set-Cookie", "Location"}}).Handler(c)
		post(h, "/p", "k", "b", nil)
		rec := post(h, "/p", "k", "b", nil)
		if rec.Code != 202 || rec.Header().Get("Location") != "/orders/1" || rec.Header().Get("Set-Cookie") != "" {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
	})
	t.Run("REQ-HTTP-9: a result over MaxResultBytes replays with an empty body and Idempotency-Replay omitted", func(t *testing.T) {
		h := httpmw.New(memory.New(), httpmw.Options{Policy: anyonce.Policy{MaxResultBytes: 1}}).Handler(&counting{status: 201})
		post(h, "/p", "k", "b", nil)
		rec := post(h, "/p", "k", "b", nil)
		if rec.Code != 201 || rec.Header().Get("Idempotency-Replay") != "omitted" || rec.Body.Len() != 0 {
			t.Fatalf("%d %v %q", rec.Code, rec.Header(), rec.Body.String())
		}
	})
	t.Run("REQ-HTTP-7: the policy cap never exceeds the store's declared cap", func(t *testing.T) {
		// No MaxResultBytes in the policy: the cap comes from the store alone, so a one byte ceiling makes the
		// replay take the omitted form.
		h := httpmw.New(capped{Store: memory.New(), limit: 1}, httpmw.Options{}).Handler(&counting{status: 201})
		post(h, "/p", "k", "b", nil)
		rec := post(h, "/p", "k", "b", nil)
		if rec.Code != 201 || rec.Header().Get("Idempotency-Replay") != "omitted" || rec.Body.Len() != 0 {
			t.Fatalf("%d %v %q", rec.Code, rec.Header(), rec.Body.String())
		}
		// A smaller explicit policy still wins: the store declares a ceiling, not a floor.
		big := httpmw.New(capped{Store: memory.New(), limit: 1 << 20}, httpmw.Options{Policy: anyonce.Policy{MaxResultBytes: 1}}).Handler(&counting{status: 201})
		post(big, "/p", "k", "b", nil)
		if rec := post(big, "/p", "k", "b", nil); rec.Header().Get("Idempotency-Replay") != "omitted" {
			t.Fatalf("%v", rec.Header())
		}
		// A store with no declared cap leaves the default in place, so the same result replays in full.
		plain := httpmw.New(memory.New(), httpmw.Options{}).Handler(&counting{status: 201})
		post(plain, "/p", "k", "b", nil)
		if rec := post(plain, "/p", "k", "b", nil); rec.Header().Get("Idempotency-Replayed") != "true" || rec.Header().Get("Idempotency-Replay") != "" || rec.Body.Len() == 0 {
			t.Fatalf("%v %q", rec.Header(), rec.Body.String())
		}
	})
	t.Run("REQ-HTTP-10: an in-flight duplicate is 409 conflict with Retry-After from the lease", func(t *testing.T) {
		var nowMs atomic.Int64
		nowMs.Store(1_000_000)
		gate := make(chan struct{})
		acquired := make(chan struct{}, 1)
		policy := anyonce.Policy{Lease: 30 * time.Second, Clock: func() time.Time { return time.UnixMilli(nowMs.Load()) }, Hooks: anyonce.Hooks{OnAcquired: func(anyonce.Operation) { acquired <- struct{}{} }}}
		h := httpmw.New(memory.New(), httpmw.Options{Policy: policy}).Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			<-gate
			_, _ = io.WriteString(w, "done")
		}))
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- post(h, "/p", "k", "b", nil) }()
		<-acquired
		nowMs.Add(4500)
		dup := post(h, "/p", "k", "b", nil)
		if dup.Code != 409 || dup.Header().Get("Retry-After") != "26" || problemCode(t, dup) != "conflict" {
			t.Fatalf("%d %v", dup.Code, dup.Header())
		}
		close(gate)
		if first := <-done; first.Body.String() != "done" {
			t.Fatal(first.Body.String())
		}
	})
	t.Run("REQ-HTTP-11: a different body under the same key is 422 fingerprint-mismatch", func(t *testing.T) {
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(&counting{status: 201})
		post(h, "/p", "k", "one", nil)
		if rec := post(h, "/p", "k", "two", nil); rec.Code != 422 || problemCode(t, rec) != "fingerprint-mismatch" {
			t.Fatal(rec.Code)
		}
	})
	t.Run("REQ-HTTP-12: fail-closed is 503 store-unavailable with Retry-After 1; fail-open runs and marks Idempotency-Degraded", func(t *testing.T) {
		c := &counting{status: 201}
		rec := post(httpmw.New(failingStore{}, httpmw.Options{}).Handler(c), "/p", "k", "b", nil)
		if rec.Code != 503 || rec.Header().Get("Retry-After") != "1" || problemCode(t, rec) != "store-unavailable" || c.calls.Load() != 0 {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
		open := post(httpmw.New(failingStore{}, httpmw.Options{Policy: anyonce.Policy{OnStoreError: anyonce.FailOpen}}).Handler(c), "/p", "k", "b", nil)
		if open.Code != 201 || open.Header().Get("Idempotency-Degraded") != "true" || c.calls.Load() != 1 {
			t.Fatalf("%d %v", open.Code, open.Header())
		}
	})
	t.Run("REQ-HTTP-13: OnError renders every problem, and fail's headers survive a custom OnError", func(t *testing.T) {
		custom := func(w http.ResponseWriter, _ *http.Request, p httpmw.Problem) {
			w.WriteHeader(p.Status)
			_, _ = io.WriteString(w, "custom:"+string(p.Code))
		}
		h := httpmw.New(memory.New(), httpmw.Options{Required: true, DocsURL: "https://d.test/keys", OnError: custom}).Handler(&counting{status: 201})
		rec := post(h, "/p", "", "b", nil)
		if rec.Code != 400 || rec.Body.String() != "custom:missing-key" || rec.Header().Get("Link") != "<https://d.test/keys>; rel=\"describedby\"" {
			t.Fatalf("%d %q %v", rec.Code, rec.Body.String(), rec.Header())
		}

		var nowMs atomic.Int64
		nowMs.Store(1_000_000)
		gate := make(chan struct{})
		acquired := make(chan struct{}, 1)
		policy := anyonce.Policy{Lease: 30 * time.Second, Clock: func() time.Time { return time.UnixMilli(nowMs.Load()) }, Hooks: anyonce.Hooks{OnAcquired: func(anyonce.Operation) { acquired <- struct{}{} }}}
		hc := httpmw.New(memory.New(), httpmw.Options{Policy: policy, OnError: custom}).Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			<-gate
			_, _ = io.WriteString(w, "done")
		}))
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- post(hc, "/p", "k", "b", nil) }()
		<-acquired
		nowMs.Add(4500)
		dup := post(hc, "/p", "k", "b", nil)
		if dup.Code != 409 || dup.Body.String() != "custom:conflict" || dup.Header().Get("Retry-After") != "26" {
			t.Fatalf("%d %q %v", dup.Code, dup.Body.String(), dup.Header())
		}
		close(gate)
		if first := <-done; first.Body.String() != "done" {
			t.Fatal(first.Body.String())
		}
	})
	t.Run("REQ-HTTP-15: Skip opts a request out", func(t *testing.T) {
		c := &counting{status: 201}
		h := httpmw.New(memory.New(), httpmw.Options{Skip: func(r *http.Request) bool { return r.URL.Path == "/reset" }}).Handler(c)
		post(h, "/reset", "k", "b", nil)
		post(h, "/reset", "k", "b", nil)
		if c.calls.Load() != 2 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-7: a 5xx is not stored so the retry executes again", func(t *testing.T) {
		c := &counting{status: 500}
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(c)
		post(h, "/p", "k", "b", nil)
		if rec := post(h, "/p", "k", "b", nil); rec.Header().Get("Idempotency-Replayed") != "" || c.calls.Load() != 2 {
			t.Fatal("expected a second execution")
		}
	})
}

func TestStreaming(t *testing.T) {
	t.Run("REQ-HTTP-7: the client reads the first chunk before the handler finishes and EOF only after the record is complete", func(t *testing.T) {
		store := memory.New()
		gate := make(chan struct{})
		h := httpmw.New(store, httpmw.Options{}).Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = io.WriteString(w, "first")
			if err := http.NewResponseController(w).Flush(); err != nil {
				panic(err)
			}
			<-gate
			_, _ = io.WriteString(w, "second")
		}))
		srv := httptest.NewServer(h)
		defer srv.Close()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/stream", strings.NewReader("b"))
		req.Header.Set("Idempotency-Key", "k1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		r := bufio.NewReader(res.Body)
		first := make([]byte, 5)
		if _, err := io.ReadFull(r, first); err != nil || string(first) != "first" {
			t.Fatalf("%q %v", first, err)
		}
		rec, _ := store.Get(context.Background(), "POST /stream", "k1", time.Now())
		if rec == nil || rec.State != anyonce.StateInFlight {
			t.Fatalf("record %+v", rec)
		}
		close(gate)
		rest, err := io.ReadAll(r)
		if err != nil || string(rest) != "second" {
			t.Fatalf("%q %v", rest, err)
		}
		rec, _ = store.Get(context.Background(), "POST /stream", "k1", time.Now())
		if rec == nil || rec.State != anyonce.StateCompleted || string(rec.Result.Body) != "firstsecond" {
			t.Fatalf("record %+v", rec)
		}
	})
	t.Run("REQ-HTTP-18: a hijacked connection passes through and the claim is abandoned", func(t *testing.T) {
		store := memory.New()
		h := httpmw.New(store, httpmw.Options{}).Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				panic(err)
			}
			_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nhijacked")
			_ = conn.Close()
		}))
		srv := httptest.NewServer(h)
		defer srv.Close()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/h", strings.NewReader("b"))
		req.Header.Set("Idempotency-Key", "k2")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if string(body) != "hijacked" {
			t.Fatal(string(body))
		}
		if rec, _ := store.Get(context.Background(), "POST /h", "k2", time.Now()); rec != nil {
			t.Fatalf("record should be abandoned, got %+v", rec)
		}
	})
	t.Run("REQ-HTTP-18: a panicking handler abandons the claim and the panic still propagates", func(t *testing.T) {
		store := memory.New()
		h := httpmw.New(store, httpmw.Options{}).Handler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("boom")
		}))
		srv := httptest.NewUnstartedServer(h)
		srv.Config.ErrorLog = log.New(io.Discard, "", 0)
		srv.Start()
		defer srv.Close()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/panic", strings.NewReader("b"))
		req.Header.Set("Idempotency-Key", "k3")
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode < 500 {
				t.Fatalf("expected a 5xx or a closed connection, got %d", res.StatusCode)
			}
		}
		if rec, _ := store.Get(context.Background(), "POST /panic", "k3", time.Now()); rec != nil {
			t.Fatalf("record should be abandoned, got %+v", rec)
		}
	})
}

func TestEarlyHints(t *testing.T) {
	t.Run("REQ-HTTP-9: a handler that sends Early Hints is replayed with its final status", func(t *testing.T) {
		store := memory.New()
		h := httpmw.New(store, httpmw.Options{}).Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Link", "</s.css>; rel=preload; as=style")
			w.WriteHeader(http.StatusEarlyHints)
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, "hinted")
		}))
		srv := httptest.NewServer(h)
		defer srv.Close()
		// The final response is the only assertion: a Go client surfaces a 1xx through httptrace, never as the
		// response it returns.
		send := func() (*http.Response, string) {
			t.Helper()
			req, _ := http.NewRequest(http.MethodPost, srv.URL+"/hints", strings.NewReader("b"))
			req.Header.Set("Idempotency-Key", "k-hints")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(res.Body)
			_ = res.Body.Close()
			return res, string(body)
		}
		first, firstBody := send()
		if first.StatusCode != http.StatusCreated || firstBody != "hinted" || first.Header.Get("Idempotency-Replayed") != "" {
			t.Fatalf("%d %q %v", first.StatusCode, firstBody, first.Header)
		}
		replay, replayBody := send()
		if replay.StatusCode != http.StatusCreated || replayBody != "hinted" || replay.Header.Get("Idempotency-Replayed") != "true" {
			t.Fatalf("%d %q %v", replay.StatusCode, replayBody, replay.Header)
		}
		rec, _ := store.Get(context.Background(), "POST /hints", "k-hints", time.Now())
		if rec == nil || rec.Result == nil || rec.Result.Status != http.StatusCreated {
			t.Fatalf("record %+v", rec)
		}
	})
}
