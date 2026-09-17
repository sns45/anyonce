// Package sqlite is the Go SQLite store (REQ-ST-SQLITE-1): sqlstore.Store configured with modernc.org/sqlite
// (cgo free, NFR-5) and numbered "?N" placeholders over the embedded SQLite schema. The pool is capped at one
// connection: SQLite serializes writers at the file level regardless, and a single connection turns that into
// the store's atomicity mechanism directly, one statement per transition, with busy_timeout absorbing brief
// contention instead of surfacing SQLITE_BUSY.
package sqlite

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"strconv"

	_ "modernc.org/sqlite"

	"github.com/sns45/anyonce/go/store/internal/sqlstore"
)

// Schema is the embedded contents of schema.sql: the same text as SQLITE_SCHEMA in the TypeScript store.
//
//go:embed schema.sql
var Schema string

var dialect = sqlstore.Dialect{
	Placeholder: func(n int) string { return "?" + strconv.Itoa(n) },
	Schema:      Schema,
}

// New builds a store over an existing database/sql handle.
func New(db *sql.DB) *sqlstore.Store {
	return sqlstore.New(db, dialect)
}

// EnsureSchema applies the SQLite schema to db; safe to call repeatedly.
func EnsureSchema(ctx context.Context, db *sql.DB) error {
	if err := New(db).EnsureSchema(ctx); err != nil {
		return fmt.Errorf("sqlite: %w", err)
	}
	return nil
}

// Open opens the database file at path through modernc.org/sqlite, pings it, sets a five second busy timeout
// and WAL journal mode, caps the connection pool at one (the atomicity mechanism: a single writer means every
// transition is one statement with no other connection able to interleave), and returns a store over it. Call
// EnsureSchema before first use.
func Open(ctx context.Context, path string) (*sqlstore.Store, error) {
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("sqlite: ping: %w", err)
	}
	return New(db), nil
}
