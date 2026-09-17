// Package postgres is the Go Postgres store (REQ-ST-PG-1): sqlstore.Store configured with pgx and $N
// placeholders over the embedded Postgres schema.
package postgres

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"strconv"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/sns45/anyonce/go/store/internal/sqlstore"
)

// Schema is the embedded contents of schema.sql: the same text as POSTGRES_SCHEMA in the TypeScript store.
//
//go:embed schema.sql
var Schema string

var dialect = sqlstore.Dialect{
	Placeholder: func(n int) string { return "$" + strconv.Itoa(n) },
	Schema:      Schema,
}

// New builds a store over an existing database/sql handle.
func New(db *sql.DB) *sqlstore.Store {
	return sqlstore.New(db, dialect)
}

// EnsureSchema applies the Postgres schema to db; safe to call repeatedly.
func EnsureSchema(ctx context.Context, db *sql.DB) error {
	if err := New(db).EnsureSchema(ctx); err != nil {
		return fmt.Errorf("postgres: %w", err)
	}
	return nil
}

// DefaultMaxOpenConns is the pool cap Open applies when Options.MaxOpenConns is zero.
const DefaultMaxOpenConns = 10

// Options configure Open. MaxOpenConns is the pool cap handed to sql.DB.SetMaxOpenConns; zero means
// DefaultMaxOpenConns, which suits an ordinary service where each request holds one connection for one
// statement. Raise it when many goroutines claim at once: the contract suite's REQ-STORE-8 race runs 50
// concurrent begins and passes 60, so no goroutine waits for a connection and the race is real contention in
// Postgres rather than in the pool.
type Options struct {
	MaxOpenConns int
}

// Open connects to dsn through pgx, pings it, caps the connection pool per opts, and returns a store over it.
// Call EnsureSchema before first use.
func Open(ctx context.Context, dsn string, opts Options) (*sqlstore.Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("postgres: open: %w", err)
	}
	maxOpen := opts.MaxOpenConns
	if maxOpen == 0 {
		maxOpen = DefaultMaxOpenConns
	}
	db.SetMaxOpenConns(maxOpen)
	if err := db.PingContext(ctx); err != nil {
		// sql.Open never dials, so the handle and its pool goroutines exist even when the ping fails.
		_ = db.Close()
		return nil, fmt.Errorf("postgres: ping: %w", err)
	}
	return New(db), nil
}
