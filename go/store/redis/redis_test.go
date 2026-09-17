package redis_test

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/internal/servicetest"
	"github.com/sns45/anyonce/go/store/redis"
	"github.com/sns45/anyonce/go/storetest"
)

func client() *goredis.Client {
	return goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:6379"})
}

// commandNames is a goredis.Hook that records the name of every command the client sends, in order, so a test
// can assert the EVALSHA-then-EVAL fallback sequence.
type commandNames struct {
	mu    sync.Mutex
	names []string
}

func (c *commandNames) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (c *commandNames) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		err := next(ctx, cmd)
		c.mu.Lock()
		c.names = append(c.names, cmd.Name())
		c.mu.Unlock()
		return err
	}
}

func (c *commandNames) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return next
}

func (c *commandNames) drain() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.names
	c.names = nil
	return out
}

func TestRedisStore(t *testing.T) {
	servicetest.Require(t, "redis", "127.0.0.1:6379")
	ctx := context.Background()
	c := client()
	t.Cleanup(func() { _ = c.Close() })

	prefix := fmt.Sprintf("go%d:", time.Now().UnixNano())
	storetest.Run(t, "redis", func(*testing.T) storetest.Harness {
		s := redis.New(c, redis.Options{Prefix: prefix})
		return storetest.Harness{Store: s, PhysicallyRemove: s.PhysicallyRemove, NativePurge: true}
	})

	t.Run("REQ-ST-REDIS-1: EVALSHA is tried first and EVAL is the fallback after SCRIPT FLUSH", func(t *testing.T) {
		hc := client()
		defer func() { _ = hc.Close() }()
		rec := &commandNames{}
		hc.AddHook(rec)
		s := redis.New(hc, redis.Options{Prefix: fmt.Sprintf("hook%d:", time.Now().UnixNano())})
		opts := anyonce.BeginOptions{Lease: storetest.Lease, TTL: storetest.TTL, Now: storetest.T0}

		if err := hc.ScriptFlush(ctx).Err(); err != nil {
			t.Fatal(err)
		}
		rec.drain()

		if _, err := s.Begin(ctx, anyonce.Operation{Scope: "s", Key: "k1", Fingerprint: "fp"}, opts); err != nil {
			t.Fatal(err)
		}
		if got := rec.drain(); len(got) != 2 || got[0] != "evalsha" || got[1] != "eval" {
			t.Fatalf("commands after SCRIPT FLUSH = %v, want [evalsha eval]", got)
		}

		if _, err := s.Begin(ctx, anyonce.Operation{Scope: "s", Key: "k2", Fingerprint: "fp"}, opts); err != nil {
			t.Fatal(err)
		}
		if got := rec.drain(); len(got) != 1 || got[0] != "evalsha" {
			t.Fatalf("commands on the next begin = %v, want [evalsha]", got)
		}
	})

	t.Run("REQ-ST-REDIS-1: the hash carries a PEXPIRE relative to the wall clock and purge is a no-op", func(t *testing.T) {
		scope := fmt.Sprintf("pexpire-%d", time.Now().UnixNano())
		s := redis.New(c, redis.Options{Prefix: prefix})
		op := anyonce.Operation{Scope: scope, Key: "k", Fingerprint: "fp"}
		if _, err := s.Begin(ctx, op, anyonce.BeginOptions{Lease: storetest.Lease, TTL: 5 * time.Second, Now: storetest.T0}); err != nil {
			t.Fatal(err)
		}

		key := prefix + op.Scope + "\x1f" + op.Key
		pttl, err := c.PTTL(ctx, key).Result()
		if err != nil {
			t.Fatal(err)
		}
		if ms := pttl.Milliseconds(); ms < 60_000 || ms > 65_000 {
			t.Fatalf("pttl = %dms, want between 60000ms and 65000ms", ms)
		}

		if n, err := s.Purge(ctx, time.Now()); err != nil || n != 0 {
			t.Fatalf("purge = %d, %v", n, err)
		}
	})

	t.Run("REQ-ST-REDIS-1: every core and profile vector passes through httpmw with the Redis store", func(t *testing.T) {
		s := redis.New(c, redis.Options{Prefix: fmt.Sprintf("conf%d:", time.Now().UnixNano())})
		f := fixture.New()
		mw := httpmw.New(s, httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		summary := conformance.Run(t, mux, conformance.Options{Capabilities: []string{"short-ttl"}})
		if summary.Passed != len(summary.Results) || len(summary.Results) != 20 {
			t.Fatalf("passed %d of %d", summary.Passed, len(summary.Results))
		}
	})
}
