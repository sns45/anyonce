package sqlstore

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/sns45/anyonce/go/storetest"
)

// sqliteSchema is SQLITE_SCHEMA from packages/stores/src/sql.ts, copied here because the sqlite package itself
// does not exist yet (it is Task 10); this in-memory database only needs the schema text, not the package.
const sqliteSchema = `
CREATE TABLE IF NOT EXISTS anyonce_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  result_meta TEXT,
  result_body BLOB,
  result_omitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS anyonce_records_expires_at ON anyonce_records (expires_at);
`

var sqliteDialect = Dialect{
	// Numbered reuse (?4 appears twice in beginSQL) needs modernc's numbered placeholder form, not a bare "?".
	Placeholder: func(n int) string { return "?" + strconv.Itoa(n) },
	Schema:      sqliteSchema,
}

func TestSQLStore(t *testing.T) {
	t.Run("REQ-ST-SQLITE-1: the shared sql store passes the contract against in memory SQLite", func(t *testing.T) {
		db, err := sql.Open("sqlite", "file::memory:?cache=shared")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close() })
		db.SetMaxOpenConns(1)

		store := New(db, sqliteDialect)
		if err := store.EnsureSchema(context.Background()); err != nil {
			t.Fatal(err)
		}

		storetest.Run(t, "sqlite", func(*testing.T) storetest.Harness {
			return storetest.Harness{Store: store, PhysicallyRemove: store.PhysicallyRemove}
		})
	})

	t.Run("REQ-ST-PG-1: render turns ?N into the dialect placeholder without touching quoted text", func(t *testing.T) {
		d := Dialect{Placeholder: func(n int) string { return "$" + strconv.Itoa(n) }}
		got := render(d, completeSQL)
		if strings.Contains(got, "?") {
			t.Fatalf("an unrendered placeholder remains: %q", got)
		}
		if !strings.Contains(got, "'completed'") || !strings.Contains(got, "'in_flight'") {
			t.Fatalf("quoted text was altered: %q", got)
		}
		for _, want := range []string{"$1", "$2", "$3", "$4", "$5", "$6", "$7"} {
			if !strings.Contains(got, want) {
				t.Fatalf("missing rendered placeholder %s: %q", want, got)
			}
		}
	})
}
