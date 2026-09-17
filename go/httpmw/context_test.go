package httpmw

import (
	"context"
	"testing"
)

func TestContext(t *testing.T) {
	t.Run("REQ-HTTP-14: KeyFromContext and FenceFromContext read what the middleware stored and report absence", func(t *testing.T) {
		ctx := withInfo(context.Background(), "k", 3)
		if key, ok := KeyFromContext(ctx); !ok || key != "k" {
			t.Fatalf("%q %v", key, ok)
		}
		if fence, ok := FenceFromContext(ctx); !ok || fence != 3 {
			t.Fatalf("%d %v", fence, ok)
		}
		if _, ok := KeyFromContext(context.Background()); ok {
			t.Fatal("expected absent")
		}
		if _, ok := FenceFromContext(context.Background()); ok {
			t.Fatal("expected absent")
		}
	})
}
