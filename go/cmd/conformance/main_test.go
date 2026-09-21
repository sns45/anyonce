package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/memory"
)

func mustContain(t *testing.T, err error, substr string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected an error containing %q, got nil", substr)
	}
	if !strings.Contains(err.Error(), substr) {
		t.Fatalf("expected error to contain %q, got %q", substr, err.Error())
	}
}

func TestParseArgs(t *testing.T) {
	t.Run("REQ-CONF-8: -url is required", func(t *testing.T) {
		_, err := parseArgs([]string{})
		mustContain(t, err, "-url")

		_, err = parseArgs([]string{"-tier", "core"})
		mustContain(t, err, "-url")
	})

	t.Run("REQ-CONF-8: an unknown tier is a usage error", func(t *testing.T) {
		_, err := parseArgs([]string{"-url", "http://example.invalid", "-tier", "bogus"})
		mustContain(t, err, "tier")
	})

	t.Run("REQ-CONF-8: an unknown capability is a usage error", func(t *testing.T) {
		_, err := parseArgs([]string{"-url", "http://example.invalid", "-capability", "bogus"})
		mustContain(t, err, "capability")
	})

	t.Run("REQ-CONF-8: -ttl-ms must be a positive integer", func(t *testing.T) {
		_, err := parseArgs([]string{"-url", "http://example.invalid", "-ttl-ms", "0"})
		mustContain(t, err, "-ttl-ms")

		_, err = parseArgs([]string{"-url", "http://example.invalid", "-ttl-ms", "-5"})
		mustContain(t, err, "-ttl-ms")
	})

	t.Run("REQ-CONF-8: -capability short-ttl with -ttl-ms above 2000 is a usage error", func(t *testing.T) {
		_, err := parseArgs([]string{
			"-url", "http://example.invalid",
			"-capability", "short-ttl",
			"-ttl-ms", "5000",
		})
		mustContain(t, err, "short-ttl")

		// At or below 2000 is fine.
		opts, err := parseArgs([]string{
			"-url", "http://example.invalid",
			"-capability", "short-ttl",
			"-ttl-ms", "2000",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if opts.ttlMs != 2000 {
			t.Fatalf("ttlMs = %d, want 2000", opts.ttlMs)
		}
	})

	t.Run("REQ-CONF-8: -tier and -only are repeatable", func(t *testing.T) {
		opts, err := parseArgs([]string{
			"-url", "http://example.invalid",
			"-tier", "core",
			"-tier", "profile",
			"-only", "core/post-executes-once",
			"-only", "core/get-ignored",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(opts.tiers) != 2 || opts.tiers[0] != "core" || opts.tiers[1] != "profile" {
			t.Fatalf("tiers = %v", opts.tiers)
		}
		if len(opts.only) != 2 || opts.only[0] != "core/post-executes-once" || opts.only[1] != "core/get-ignored" {
			t.Fatalf("only = %v", opts.only)
		}
	})
}

// idempotentFixtureHandler wires the conformance fixture behind httpmw exactly as go/cmd/fixture does with
// -idempotent, using the in-memory store, so an httptest server can stand in for that binary in these tests.
func idempotentFixtureHandler() http.Handler {
	f := fixture.New()
	mw := httpmw.New(memory.New(), httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second}})
	mux := http.NewServeMux()
	mux.Handle("POST /reset", f.Handler())
	mux.Handle("/", mw.Handler(f.Handler()))
	return mux
}

type jsonReport struct {
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Results []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"results"`
}

func TestRunEndToEnd(t *testing.T) {
	t.Run("REQ-CONF-8: -only selects a single vector", func(t *testing.T) {
		srv := httptest.NewServer(idempotentFixtureHandler())
		defer srv.Close()

		opts, err := parseArgs([]string{
			"-url", srv.URL,
			"-only", "core/post-executes-once",
			"-report", "json",
		})
		if err != nil {
			t.Fatalf("parseArgs: %v", err)
		}
		var out bytes.Buffer
		code, err := run(context.Background(), opts, &out)
		if err != nil {
			t.Fatalf("run: %v", err)
		}
		if code != 0 {
			t.Fatalf("code = %d, want 0; output: %s", code, out.String())
		}
		var report jsonReport
		if err := json.Unmarshal(out.Bytes(), &report); err != nil {
			t.Fatalf("unmarshal report: %v; output: %s", err, out.String())
		}
		if len(report.Results) != 1 {
			t.Fatalf("results = %v, want exactly one", report.Results)
		}
		if report.Results[0].ID != "core/post-executes-once" || report.Results[0].Status != "pass" {
			t.Fatalf("result = %+v, want core/post-executes-once pass", report.Results[0])
		}
	})
}

// capturingListener records every byte read off every connection it accepts, so a test can inspect what
// actually crossed the wire rather than what net/http's server parsed the request into: textproto's header
// reader canonicalizes every field name it parses (REQ-CONF-6's comment in go/conformance/run.go notes the
// same canonicalization on the client's Header.Set path), so http.Request.Header can never show a lowercase
// "idempotency-key" even when that is exactly what arrived. Only the raw bytes can answer Q52.
type capturingListener struct {
	net.Listener
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *capturingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &capturingConn{Conn: c, listener: l}, nil
}

func (l *capturingListener) snapshot() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

type capturingConn struct {
	net.Conn
	listener *capturingListener
}

func (c *capturingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.listener.mu.Lock()
		c.listener.buf.Write(p[:n])
		c.listener.mu.Unlock()
	}
	return n, err
}

func TestLowercaseHeaderOnTheWire(t *testing.T) {
	t.Run("REQ-CONF-8: the lowercase header spelling reaches the target", func(t *testing.T) {
		srv := httptest.NewUnstartedServer(idempotentFixtureHandler())
		if err := srv.Listener.Close(); err != nil {
			t.Fatal(err)
		}
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		capListener := &capturingListener{Listener: ln}
		srv.Listener = capListener
		srv.Start()
		defer srv.Close()

		opts, err := parseArgs([]string{
			"-url", srv.URL,
			"-only", "core/header-name-case-insensitive",
			"-report", "json",
		})
		if err != nil {
			t.Fatalf("parseArgs: %v", err)
		}
		var out bytes.Buffer
		code, err := run(context.Background(), opts, &out)
		if err != nil {
			t.Fatalf("run: %v", err)
		}

		wire := capListener.snapshot()
		if !strings.Contains(wire, "Idempotency-Key: k-case-1") {
			t.Fatalf("expected the first step's canonical spelling on the wire; captured:\n%s", wire)
		}
		if !strings.Contains(wire, "idempotency-key: k-case-1") {
			t.Fatalf("the lowercase spelling the vector's retry step sent never reached the wire; Q52's premise "+
				"does not hold for this runner; captured:\n%s", wire)
		}

		var report jsonReport
		if err := json.Unmarshal(out.Bytes(), &report); err != nil {
			t.Fatalf("unmarshal report: %v; output: %s", err, out.String())
		}
		if len(report.Results) != 1 || report.Results[0].Status != "pass" {
			t.Fatalf("result = %+v, want one passing result", report.Results)
		}
		if code != 0 {
			t.Fatalf("code = %d, want 0", code)
		}
	})
}
