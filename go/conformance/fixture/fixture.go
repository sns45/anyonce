// Package fixture is the reference net/http fixture for the anyonce conformance suite
// (requirements REQ-CONF-2). It has no idempotency layer; httpmw wraps Handler() in P2.
package fixture

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

// Fixture holds the process-global handler invocation counter.
type Fixture struct {
	count atomic.Int64
}

// New returns a fixture with a zero counter.
func New() *Fixture { return &Fixture{} }

// Count returns the number of POST fixture invocations since the last Reset.
func (f *Fixture) Count() int { return int(f.count.Load()) }

// Reset zeroes the counter.
func (f *Fixture) Reset() { f.count.Store(0) }

// Handler returns the fixture routes. Every POST fixture increments the counter;
// /reset is the only control endpoint and must stay outside any idempotency layer.
func (f *Fixture) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /reset", func(w http.ResponseWriter, _ *http.Request) {
		f.Reset()
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /counter", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"count": f.Count()})
	})

	mux.HandleFunc("POST /echo", func(w http.ResponseWriter, r *http.Request) {
		f.count.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read body", http.StatusBadRequest)
			return
		}
		ct := r.Header.Get("Content-Type")
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(body)
	})

	mux.HandleFunc("POST /status/{code}", func(w http.ResponseWriter, r *http.Request) {
		code, err := strconv.Atoi(r.PathValue("code"))
		if err != nil || code < 200 || code > 599 {
			http.Error(w, "invalid status code", http.StatusBadRequest)
			return
		}
		f.count.Add(1)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(code)
		_, _ = io.WriteString(w, "status:"+strconv.Itoa(code))
	})

	mux.HandleFunc("POST /slow", func(w http.ResponseWriter, r *http.Request) {
		f.count.Add(1)
		ms, err := strconv.Atoi(r.URL.Query().Get("ms"))
		if err != nil || ms < 0 {
			ms = 0
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "slept:"+strconv.Itoa(ms))
	})

	mux.HandleFunc("POST /large", func(w http.ResponseWriter, r *http.Request) {
		f.count.Add(1)
		n, err := strconv.Atoi(r.URL.Query().Get("bytes"))
		if err != nil || n < 0 {
			n = 0
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(n))
		_, _ = io.Copy(w, bytes.NewReader(bytes.Repeat([]byte{'x'}, n)))
	})

	return mux
}
