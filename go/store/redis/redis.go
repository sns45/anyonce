// Package redis is the Redis store (REQ-ST-REDIS-1): begin, complete and abandon are each one Lua script run
// as EVALSHA with an EVAL fallback on NOSCRIPT, one hash per record, and a PEXPIRE sweeps expired hashes.
package redis

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/internal/rowcodec"
)

// DefaultPrefix is the key prefix New uses when Options.Prefix is empty.
const DefaultPrefix = "anyonce:"

// DefaultNativeTTLGrace is added to the PEXPIRE deadline when Options.NativeTTLGrace is zero.
const DefaultNativeTTLGrace = 60 * time.Second

const inFlight = string(anyonce.StateInFlight)

// Options configure the store. Prefix defaults to DefaultPrefix. NativeTTLGrace is added to the PEXPIRE so a
// late complete from the previous fence holder still finds its hash; it defaults to DefaultNativeTTLGrace.
type Options struct {
	Prefix         string
	NativeTTLGrace time.Duration
}

// Store is the Redis implementation of anyonce.Store.
type Store struct {
	client         goredis.UniversalClient
	prefix         string
	grace          time.Duration
	beginScript    *goredis.Script
	completeScript *goredis.Script
	abandonScript  *goredis.Script
}

// New builds a store over an existing Redis client. client may be a single-node client, a sentinel-backed
// failover client, a ring or a cluster client; all satisfy goredis.UniversalClient.
func New(client goredis.UniversalClient, opts Options) *Store {
	s := &Store{
		client:         client,
		prefix:         opts.Prefix,
		grace:          opts.NativeTTLGrace,
		beginScript:    goredis.NewScript(beginLua),
		completeScript: goredis.NewScript(completeLua),
		abandonScript:  goredis.NewScript(abandonLua),
	}
	if s.prefix == "" {
		s.prefix = DefaultPrefix
	}
	if s.grace == 0 {
		s.grace = DefaultNativeTTLGrace
	}
	return s
}

// key is prefix + scope + 0x1f + key, matching the TypeScript store.
func (s *Store) key(scope, k string) string {
	return s.prefix + scope + "\x1f" + k
}

// toString accepts the two shapes a RESP reply element arrives in: a Go string for a bulk string, or a byte
// slice when the client is configured for raw bytes.
func toString(v interface{}) (string, error) {
	switch val := v.(type) {
	case string:
		return val, nil
	case []byte:
		return string(val), nil
	default:
		return "", fmt.Errorf("redis: unexpected reply element type %T", v)
	}
}

// toInt64 accepts a Lua number, which go-redis surfaces as int64, or a Lua string carrying a hash field value
// verbatim.
func toInt64(v interface{}) (int64, error) {
	switch val := v.(type) {
	case int64:
		return val, nil
	case string:
		n, err := strconv.ParseInt(val, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("redis: not an integer: %q", val)
		}
		return n, nil
	default:
		return 0, fmt.Errorf("redis: unexpected reply element type %T", v)
	}
}

// pairsToFields flattens a Lua HGETALL reply (alternating field, value) into a map.
func pairsToFields(pairs []interface{}) (map[string]string, error) {
	fields := make(map[string]string, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		k, err := toString(pairs[i])
		if err != nil {
			return nil, err
		}
		v, err := toString(pairs[i+1])
		if err != nil {
			return nil, err
		}
		fields[k] = v
	}
	return fields, nil
}

// numField returns the field parsed as an int64, or 0 when absent or not numeric, mirroring the TypeScript
// store's Number(fields.x ?? 0).
func numField(fields map[string]string, name string) int64 {
	v, ok := fields[name]
	if !ok || v == "" {
		return 0
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// fieldsToRow turns a hash's fields into a rowcodec.Row, base64-decoding the body.
func fieldsToRow(scope, key string, fields map[string]string) (rowcodec.Row, error) {
	row := rowcodec.Row{
		Scope:         scope,
		Key:           key,
		Fingerprint:   fields["fingerprint"],
		State:         fields["state"],
		Fence:         numField(fields, "fence"),
		LeaseUntil:    numField(fields, "lease_until"),
		CreatedAt:     numField(fields, "created_at"),
		ExpiresAt:     numField(fields, "expires_at"),
		ResultOmitted: numField(fields, "result_omitted"),
	}
	if row.State == "" {
		row.State = inFlight
	}
	if meta, ok := fields["result_meta"]; ok {
		row.ResultMeta = &meta
	}
	if body, ok := fields["result_body"]; ok {
		decoded, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			return rowcodec.Row{}, fmt.Errorf("redis: decode result_body: %w", err)
		}
		row.ResultBody = decoded
	}
	return row, nil
}

// Begin runs beginLua: KEYS[1] the hash, ARGV fingerprint, now, leaseMs, ttlMs, graceMs.
func (s *Store) Begin(ctx context.Context, op anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	reply, err := s.beginScript.Run(ctx, s.client,
		[]string{s.key(op.Scope, op.Key)},
		op.Fingerprint,
		strconv.FormatInt(opts.Now.UnixMilli(), 10),
		strconv.FormatInt(opts.Lease.Milliseconds(), 10),
		strconv.FormatInt(opts.TTL.Milliseconds(), 10),
		strconv.FormatInt(s.grace.Milliseconds(), 10),
	).Slice()
	if err != nil {
		return anyonce.BeginOutcome{}, fmt.Errorf("redis: begin: %w", err)
	}
	if len(reply) == 0 {
		return anyonce.BeginOutcome{}, fmt.Errorf("redis: begin: empty reply")
	}
	tag, err := toString(reply[0])
	if err != nil {
		return anyonce.BeginOutcome{}, fmt.Errorf("redis: begin: %w", err)
	}
	switch tag {
	case "acquired":
		fence, err := toInt64(reply[1])
		if err != nil {
			return anyonce.BeginOutcome{}, fmt.Errorf("redis: begin: %w", err)
		}
		return anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: fence}, nil
	case "in_flight":
		leaseUntil, err := toInt64(reply[1])
		if err != nil {
			return anyonce.BeginOutcome{}, fmt.Errorf("redis: begin: %w", err)
		}
		return anyonce.BeginOutcome{Kind: anyonce.BeginInFlight, LeaseUntil: time.UnixMilli(leaseUntil).UTC()}, nil
	case "completed", "mismatch":
		fields, err := pairsToFields(reply[1:])
		if err != nil {
			return anyonce.BeginOutcome{}, fmt.Errorf("redis: begin: %w", err)
		}
		row, err := fieldsToRow(op.Scope, op.Key, fields)
		if err != nil {
			return anyonce.BeginOutcome{}, fmt.Errorf("redis: begin: %w", err)
		}
		record := rowcodec.ToRecord(row)
		kind := anyonce.BeginCompleted
		if tag == "mismatch" {
			kind = anyonce.BeginMismatch
		}
		return anyonce.BeginOutcome{Kind: kind, Record: &record}, nil
	default:
		return anyonce.BeginOutcome{}, fmt.Errorf("redis: begin: unexpected reply tag %q", tag)
	}
}

// Complete runs completeLua: ARGV fence, now, meta, body ('-' for none), omitted.
func (s *Store) Complete(ctx context.Context, op anyonce.Operation, fence int64, result anyonce.StoredResult, now time.Time) (anyonce.CompleteStatus, error) {
	meta, err := rowcodec.EncodeMeta(result)
	if err != nil {
		return "", fmt.Errorf("redis: complete: %w", err)
	}
	body := "-"
	if !result.Omitted && result.Body != nil {
		body = base64.StdEncoding.EncodeToString(result.Body)
	}
	omitted := "0"
	if result.Omitted {
		omitted = "1"
	}
	reply, err := s.completeScript.Run(ctx, s.client,
		[]string{s.key(op.Scope, op.Key)},
		strconv.FormatInt(fence, 10),
		strconv.FormatInt(now.UnixMilli(), 10),
		meta,
		body,
		omitted,
	).Text()
	if err != nil {
		return "", fmt.Errorf("redis: complete: %w", err)
	}
	return anyonce.CompleteStatus(reply), nil
}

// Abandon runs abandonLua: ARGV fence.
func (s *Store) Abandon(ctx context.Context, op anyonce.Operation, fence int64) (anyonce.CompleteStatus, error) {
	reply, err := s.abandonScript.Run(ctx, s.client,
		[]string{s.key(op.Scope, op.Key)},
		strconv.FormatInt(fence, 10),
	).Text()
	if err != nil {
		return "", fmt.Errorf("redis: abandon: %w", err)
	}
	return anyonce.CompleteStatus(reply), nil
}

// Get is an HGETALL plus the logical expiry check; a hash with no fingerprint field counts as absent.
func (s *Store) Get(ctx context.Context, scope, key string, now time.Time) (*anyonce.Record, error) {
	fields, err := s.client.HGetAll(ctx, s.key(scope, key)).Result()
	if err != nil {
		return nil, fmt.Errorf("redis: get: %w", err)
	}
	if _, ok := fields["fingerprint"]; !ok {
		return nil, nil
	}
	row, err := fieldsToRow(scope, key, fields)
	if err != nil {
		return nil, fmt.Errorf("redis: get: %w", err)
	}
	if row.ExpiresAt <= now.UnixMilli() {
		return nil, nil
	}
	record := rowcodec.ToRecord(row)
	return &record, nil
}

// Purge is a no-op that returns 0: PEXPIRE sweeps expired hashes (REQ-ST-REDIS-1, Q21).
func (s *Store) Purge(context.Context, time.Time) (int, error) {
	return 0, nil
}

// PhysicallyRemove deletes the hash unconditionally, which is what a PEXPIRE sweep does. Test-only.
func (s *Store) PhysicallyRemove(ctx context.Context, scope, key string) error {
	if err := s.client.Del(ctx, s.key(scope, key)).Err(); err != nil {
		return fmt.Errorf("redis: physically remove: %w", err)
	}
	return nil
}
