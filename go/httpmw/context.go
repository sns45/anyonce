package httpmw

import "context"

type ctxKey struct{}

type info struct {
	key   string
	fence int64
}

// withInfo stores the key and fence of the claim a handler runs under.
func withInfo(ctx context.Context, key string, fence int64) context.Context {
	return context.WithValue(ctx, ctxKey{}, info{key: key, fence: fence})
}

// KeyFromContext returns the idempotency key the handler runs under (REQ-HTTP-14).
func KeyFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxKey{}).(info)
	return v.key, ok
}

// FenceFromContext returns the fence of the claim the handler runs under (REQ-HTTP-14).
func FenceFromContext(ctx context.Context) (int64, bool) {
	v, ok := ctx.Value(ctxKey{}).(info)
	return v.fence, ok
}
