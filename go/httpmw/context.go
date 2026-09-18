package httpmw

import (
	"context"

	"github.com/sns45/anyonce/go/internal/httpx"
)

// KeyFromContext returns the idempotency key the handler runs under (REQ-HTTP-14).
func KeyFromContext(ctx context.Context) (string, bool) { return httpx.KeyFromContext(ctx) }

// FenceFromContext returns the fence of the claim the handler runs under (REQ-HTTP-14).
func FenceFromContext(ctx context.Context) (int64, bool) { return httpx.FenceFromContext(ctx) }
