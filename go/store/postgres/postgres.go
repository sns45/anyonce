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

// Open connects to dsn through pgx, pings it, sets the connection pool cap the concurrency contract test needs,
// and returns a store over it. Call EnsureSchema before first use.
func Open(ctx context.Context, dsn string) (*sqlstore.Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("postgres: open: %w", err)
	}
	db.SetMaxOpenConns(60)
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("postgres: ping: %w", err)
	}
	return New(db), nil
}
