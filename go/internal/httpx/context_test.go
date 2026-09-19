package httpx_test

import (
	"context"
	"testing"

	"github.com/sns45/anyonce/go/internal/httpx"
)

func TestContext(t *testing.T) {
	t.Run("REQ-HTTP-14: KeyFromContext and FenceFromContext read what the middleware stored and report absence", func(t *testing.T) {
		ctx := httpx.WithInfo(context.Background(), "k", 3)
		if key, ok := httpx.KeyFromContext(ctx); !ok || key != "k" {
			t.Fatalf("%q %v", key, ok)
		}
		if fence, ok := httpx.FenceFromContext(ctx); !ok || fence != 3 {
			t.Fatalf("%d %v", fence, ok)
		}
		if _, ok := httpx.KeyFromContext(context.Background()); ok {
			t.Fatal("expected absent")
		}
		if _, ok := httpx.FenceFromContext(context.Background()); ok {
			t.Fatal("expected absent")
		}
	})
}
