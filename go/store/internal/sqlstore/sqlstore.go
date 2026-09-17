// Package sqlstore is the database/sql store shared by Postgres and SQLite: one conditional statement per
// transition, a follow-up SELECT to classify a refused write.
package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/internal/rowcodec"
)

// Dialect is what differs between SQLite and Postgres.
type Dialect struct {
	// Placeholder renders the nth (1-based) parameter: "?N" for SQLite, "$N" for Postgres.
	Placeholder func(n int) string
	// Schema is the CREATE statements, split on ";".
	Schema string
}

// beginSQL binds precomputed values: ?4 is now, ?5 is lease_until, ?6 is expires_at. The caller precomputes ?5
// and ?6 because after render rewrites ?N to $N, an expression such as $4 + $5 is an ambiguous operator to
// Postgres; binding the final values keeps one statement working for both dialects.
const beginSQL = `
INSERT INTO anyonce_records (scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted)
VALUES (?1, ?2, ?3, 'in_flight', 1, ?5, ?4, ?6, NULL, NULL, 0)
ON CONFLICT(scope, key) DO UPDATE SET
  fingerprint = excluded.fingerprint,
  state = 'in_flight',
  fence = anyonce_records.fence + 1,
  lease_until = excluded.lease_until,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  result_meta = NULL,
  result_body = NULL,
  result_omitted = 0
WHERE anyonce_records.expires_at <= ?4
   OR (anyonce_records.fingerprint = excluded.fingerprint AND anyonce_records.state = 'in_flight' AND anyonce_records.lease_until <= ?4)
RETURNING fence`

// completeSQL: ?1 scope, ?2 key, ?3 fence, ?4 now, ?5 result_meta, ?6 result_body, ?7 result_omitted.
const completeSQL = `
UPDATE anyonce_records SET state = 'completed', result_meta = ?5, result_body = ?6, result_omitted = ?7
WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND expires_at > ?4 AND state = 'in_flight'
RETURNING fence`

// abandonSQL: ?1 scope, ?2 key, ?3 fence.
const abandonSQL = `
DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND state = 'in_flight'
RETURNING fence`

// selectSQL: ?1 scope, ?2 key: the raw row, expired or not, used to classify a refused write.
const selectSQL = `
SELECT scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted
FROM anyonce_records WHERE scope = ?1 AND key = ?2`

// getSQL: ?1 scope, ?2 key, ?3 now.
const getSQL = `
SELECT scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted
FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND expires_at > ?3`

// purgeSQL: ?1 now. Go counts RowsAffected rather than using RETURNING.
const purgeSQL = `DELETE FROM anyonce_records WHERE expires_at <= ?1`

// removeSQL: ?1 scope, ?2 key: test-only physical removal.
const removeSQL = `DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2`

// render replaces ?N with the dialect placeholder. Positional reuse (?4 twice) is fine for both dialects when the
// argument list is passed in order, because SQLite and pgx both support numbered parameters.
// render rewrites the "?N" placeholders in a statement to the dialect's form. It is a plain text replacement
// and is not quote aware, which is safe because the only statements it ever sees are the constants in this
// file: their single-quoted literals are 'in_flight' and 'completed', neither of which contains a "?", and
// nothing here is ever built from caller input. The loop counts down so "?1" cannot match inside "?10" and up.
func render(d Dialect, text string) string {
	out := text
	for n := 9; n >= 1; n-- {
		out = strings.ReplaceAll(out, "?"+strconv.Itoa(n), d.Placeholder(n))
	}
	return out
}

// Store implements anyonce.Store over database/sql.
type Store struct {
	db       *sql.DB
	d        Dialect
	begin    string
	complete string
	abandon  string
	sel      string
	get      string
	purge    string
	remove   string
}

// New builds a store; call EnsureSchema first on a fresh database.
func New(db *sql.DB, d Dialect) *Store {
	return &Store{
		db:       db,
		d:        d,
		begin:    render(d, beginSQL),
		complete: render(d, completeSQL),
		abandon:  render(d, abandonSQL),
		sel:      render(d, selectSQL),
		get:      render(d, getSQL),
		purge:    render(d, purgeSQL),
		remove:   render(d, removeSQL),
	}
}

// EnsureSchema applies the dialect's schema statements; safe to call repeatedly.
func (s *Store) EnsureSchema(ctx context.Context) error {
	for _, stmt := range strings.Split(s.d.Schema, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("sqlstore: ensure schema: %w", err)
		}
	}
	return nil
}

func ms(t time.Time) int64 { return t.UnixMilli() }

// scanRow reads result_body into an any rather than a []byte: modernc.org/sqlite hands back a nil []byte for a
// zero length blob, which a []byte destination cannot tell apart from SQL NULL. Inside an interface the two do
// differ, a typed nil slice against an untyped nil, and that is what keeps a stored empty body from reading
// back as an absent one (REQ-STORE-4).
func scanRow(rows *sql.Rows) (rowcodec.Row, error) {
	var r rowcodec.Row
	var meta sql.NullString
	var body any
	if err := rows.Scan(&r.Scope, &r.Key, &r.Fingerprint, &r.State, &r.Fence, &r.LeaseUntil, &r.CreatedAt, &r.ExpiresAt, &meta, &body, &r.ResultOmitted); err != nil {
		return r, fmt.Errorf("sqlstore: scan: %w", err)
	}
	switch v := body.(type) {
	case nil:
		r.ResultBody = nil
	case []byte:
		if v == nil {
			v = []byte{}
		}
		r.ResultBody = v
	case string:
		r.ResultBody = make([]byte, len(v))
		copy(r.ResultBody, v)
	default:
		return r, fmt.Errorf("sqlstore: scan: result_body came back as %T, want bytes or NULL", body)
	}
	if meta.Valid {
		r.ResultMeta = &meta.String
	}
	return r, nil
}

func (s *Store) selectRow(ctx context.Context, scope, key string) (*rowcodec.Row, error) {
	rows, err := s.db.QueryContext(ctx, s.sel, scope, key)
	if err != nil {
		return nil, fmt.Errorf("sqlstore: select: %w", err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		return nil, rows.Err()
	}
	r, err := scanRow(rows)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) execReturning(ctx context.Context, query string, args ...any) (bool, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return false, fmt.Errorf("sqlstore: exec: %w", err)
	}
	defer func() { _ = rows.Close() }()
	return rows.Next(), rows.Err()
}

// Begin is one conditional statement; a refused write is classified by one SELECT (plan decisions).
func (s *Store) Begin(ctx context.Context, op anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	now := ms(opts.Now)
	leaseUntil := ms(opts.Now.Add(opts.Lease))
	expiresAt := ms(opts.Now.Add(opts.TTL))
	for attempt := 0; attempt < 3; attempt++ {
		rows, err := s.db.QueryContext(ctx, s.begin, op.Scope, op.Key, op.Fingerprint, now, leaseUntil, expiresAt)
		if err != nil {
			return anyonce.BeginOutcome{}, fmt.Errorf("sqlstore: begin: %w", err)
		}
		if rows.Next() {
			var fence int64
			err := rows.Scan(&fence)
			_ = rows.Close()
			if err != nil {
				return anyonce.BeginOutcome{}, fmt.Errorf("sqlstore: begin scan: %w", err)
			}
			return anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: fence}, nil
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return anyonce.BeginOutcome{}, fmt.Errorf("sqlstore: begin: %w", err)
		}
		_ = rows.Close()
		existing, err := s.selectRow(ctx, op.Scope, op.Key)
		if err != nil {
			return anyonce.BeginOutcome{}, err
		}
		if existing == nil || existing.ExpiresAt <= now {
			continue
		}
		rec := rowcodec.ToRecord(*existing)
		switch {
		case existing.Fingerprint != op.Fingerprint:
			return anyonce.BeginOutcome{Kind: anyonce.BeginMismatch, Record: &rec}, nil
		case existing.State == string(anyonce.StateCompleted):
			return anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &rec}, nil
		case existing.LeaseUntil > now:
			return anyonce.BeginOutcome{Kind: anyonce.BeginInFlight, LeaseUntil: rec.LeaseUntil}, nil
		}
	}
	return anyonce.BeginOutcome{}, errors.New("sqlstore: begin could not settle after three attempts")
}

// Complete stores the result if the fence still holds and the row is live and in flight. A refused write is
// classified: absent or expired is not_found, a fence mismatch is stale_fence, otherwise the row is already
// completed at this fence and completing twice is ok.
func (s *Store) Complete(ctx context.Context, op anyonce.Operation, fence int64, result anyonce.StoredResult, now time.Time) (anyonce.CompleteStatus, error) {
	meta, err := rowcodec.EncodeMeta(result)
	if err != nil {
		return "", fmt.Errorf("sqlstore: complete: %w", err)
	}
	nowMs := ms(now)
	var body []byte
	if !result.Omitted {
		body = result.Body
	}
	omitted := int64(0)
	if result.Omitted {
		omitted = 1
	}
	ok, err := s.execReturning(ctx, s.complete, op.Scope, op.Key, fence, nowMs, meta, body, omitted)
	if err != nil {
		return "", fmt.Errorf("sqlstore: complete: %w", err)
	}
	if ok {
		return anyonce.CompleteOK, nil
	}
	existing, err := s.selectRow(ctx, op.Scope, op.Key)
	if err != nil {
		return "", err
	}
	if existing == nil || existing.ExpiresAt <= nowMs {
		return anyonce.CompleteNotFound, nil
	}
	if existing.Fence != fence {
		return anyonce.CompleteStaleFence, nil
	}
	return anyonce.CompleteOK, nil
}

// Abandon deletes the in-flight row if the fence still holds. A refused delete is classified: absent or not in
// flight is not_found, a fence mismatch is stale_fence, otherwise not_found.
func (s *Store) Abandon(ctx context.Context, op anyonce.Operation, fence int64) (anyonce.CompleteStatus, error) {
	ok, err := s.execReturning(ctx, s.abandon, op.Scope, op.Key, fence)
	if err != nil {
		return "", fmt.Errorf("sqlstore: abandon: %w", err)
	}
	if ok {
		return anyonce.CompleteOK, nil
	}
	existing, err := s.selectRow(ctx, op.Scope, op.Key)
	if err != nil {
		return "", err
	}
	if existing == nil || existing.State != string(anyonce.StateInFlight) {
		return anyonce.CompleteNotFound, nil
	}
	if existing.Fence == fence {
		return anyonce.CompleteNotFound, nil
	}
	return anyonce.CompleteStaleFence, nil
}

// Get reads the record; a row past its expires_at counts as absent.
func (s *Store) Get(ctx context.Context, scope, key string, now time.Time) (*anyonce.Record, error) {
	rows, err := s.db.QueryContext(ctx, s.get, scope, key, ms(now))
	if err != nil {
		return nil, fmt.Errorf("sqlstore: get: %w", err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		return nil, rows.Err()
	}
	r, err := scanRow(rows)
	if err != nil {
		return nil, err
	}
	rec := rowcodec.ToRecord(r)
	return &rec, nil
}

// Purge deletes expired rows and reports how many were removed.
func (s *Store) Purge(ctx context.Context, now time.Time) (int, error) {
	res, err := s.db.ExecContext(ctx, s.purge, ms(now))
	if err != nil {
		return 0, fmt.Errorf("sqlstore: purge: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("sqlstore: purge rows affected: %w", err)
	}
	return int(n), nil
}

// PhysicallyRemove deletes the row unconditionally. Test-only.
func (s *Store) PhysicallyRemove(ctx context.Context, scope, key string) error {
	if _, err := s.db.ExecContext(ctx, s.remove, scope, key); err != nil {
		return fmt.Errorf("sqlstore: physically remove: %w", err)
	}
	return nil
}
