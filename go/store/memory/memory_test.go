package memory_test

import (
	"context"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/storetest"
)

func TestMemoryStoreContract(t *testing.T) {
	storetest.Run(t, "memory", func(*testing.T) storetest.Harness {
		s := memory.New()
		return storetest.Harness{Store: s, PhysicallyRemove: s.PhysicallyRemove}
	})
}

func TestMemoryStoreExtras(t *testing.T) {
	t.Run("REQ-CORE-6: records returned to callers are copies", func(t *testing.T) {
		s := memory.New()
		ctx := context.Background()
		op := anyonce.Operation{Scope: "s", Key: "k", Fingerprint: "f"}
		if _, err := s.Begin(ctx, op, anyonce.BeginOptions{Lease: storetest.Lease, TTL: storetest.TTL, Now: storetest.T0}); err != nil {
			t.Fatal(err)
		}
		body := []byte{9, 9}
		if _, err := s.Complete(ctx, op, 1, anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: body}, storetest.T0); err != nil {
			t.Fatal(err)
		}
		body[0] = 1
		rec, _ := s.Get(ctx, "s", "k", storetest.T0)
		if rec.Result.Body[0] != 9 {
			t.Fatal("store shared the caller's slice")
		}
		rec.Result.Body[1] = 1
		again, _ := s.Get(ctx, "s", "k", storetest.T0)
		if again.Result.Body[1] != 9 {
			t.Fatal("caller mutated store state")
		}
		if s.Len() != 1 {
			t.Fatalf("len %d", s.Len())
		}
	})
	t.Run("REQ-CORE-6: a cancelled context is honored", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := memory.New().Begin(ctx, anyonce.Operation{Scope: "s", Key: "k"}, anyonce.BeginOptions{Now: storetest.T0}); err == nil {
			t.Fatal("expected context error")
		}
	})
}
