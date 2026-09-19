// Command fixture serves the conformance fixture, bare by default or behind httpmw with -idempotent. -store
// picks the backing store behind httpmw (memory, dynamodb, redis, postgres or sqlite); it is meaningful only
// together with -idempotent. Each service-backed store is built from the same connection defaults the Go
// service tests use (go/internal/servicetest and the store package tests under go/store/*): DynamoDB Local on
// 127.0.0.1:18000, Redis on 127.0.0.1:6379, Postgres on 127.0.0.1:15432. An unreachable or misconfigured
// service is a fatal error naming the compose command that starts it, never a silent fallback to memory.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	goredis "github.com/redis/go-redis/v9"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/dynamodb"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/store/postgres"
	redisstore "github.com/sns45/anyonce/go/store/redis"
	"github.com/sns45/anyonce/go/store/sqlite"
)

// composeHint names the command that brings up the service containers test/compose.yml describes.
const composeHint = "run docker compose -f test/compose.yml up -d --wait"

// postgresDSN matches the dsn constant in go/store/postgres/postgres_test.go.
const postgresDSN = "postgres://anyonce:anyonce@127.0.0.1:15432/anyonce?sslmode=disable"

func newDynamoDBStore(ctx context.Context) (anyonce.Store, func(), error) {
	client := awsdynamodb.New(awsdynamodb.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String("http://127.0.0.1:18000"),
		Credentials:  credentials.NewStaticCredentialsProvider("local", "local", ""),
	})
	if err := dynamodb.EnsureTable(ctx, client, dynamodb.DefaultTable); err != nil {
		return nil, nil, fmt.Errorf("dynamodb not reachable on 127.0.0.1:18000 (%s): %w", composeHint, err)
	}
	return dynamodb.New(client, dynamodb.Options{}), func() {}, nil
}

func newRedisStore(ctx context.Context) (anyonce.Store, func(), error) {
	client := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:6379"})
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, nil, fmt.Errorf("redis not reachable on 127.0.0.1:6379 (%s): %w", composeHint, err)
	}
	return redisstore.New(client, redisstore.Options{}), func() { _ = client.Close() }, nil
}

func newPostgresStore(ctx context.Context) (anyonce.Store, func(), error) {
	store, err := postgres.Open(ctx, postgresDSN, postgres.Options{})
	if err != nil {
		return nil, nil, fmt.Errorf("postgres not reachable on 127.0.0.1:15432 (%s): %w", composeHint, err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		return nil, nil, fmt.Errorf("postgres schema setup failed: %w", err)
	}
	return store, func() {}, nil
}

// sqliteTempPaths lists every file sqlite.Open can leave behind for a database at path. Open sets
// journal_mode(WAL), so SQLite writes a "-wal" write ahead log and a "-shm" shared memory index next to the
// database file. sqlstore.Store exposes no Close and sqlite.Open does not hand back the *sql.DB, so the
// fixture cannot checkpoint the log away; it removes all three names instead. Removing only the ".db" name
// leaks two files per run into the temp directory.
func sqliteTempPaths(path string) []string {
	return []string{path, path + "-wal", path + "-shm"}
}

func removeSQLiteTemp(path string) {
	for _, p := range sqliteTempPaths(path) {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			log.Printf("remove sqlite temp file %s: %v", p, err)
		}
	}
}

func newSQLiteStore(ctx context.Context) (anyonce.Store, func(), error) {
	f, err := os.CreateTemp("", "anyonce-fixture-*.db")
	if err != nil {
		return nil, nil, fmt.Errorf("create sqlite temp file: %w", err)
	}
	path := f.Name()
	if err := f.Close(); err != nil {
		removeSQLiteTemp(path)
		return nil, nil, fmt.Errorf("close sqlite temp file: %w", err)
	}
	store, err := sqlite.Open(ctx, path)
	if err != nil {
		removeSQLiteTemp(path)
		return nil, nil, fmt.Errorf("open sqlite store at %s: %w", path, err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		removeSQLiteTemp(path)
		return nil, nil, fmt.Errorf("ensure sqlite schema: %w", err)
	}
	return store, func() { removeSQLiteTemp(path) }, nil
}

// newStore builds the store named by -store: memory (the default, also chosen by an empty name), dynamodb,
// redis, postgres or sqlite. Refactored out of main so a test can call it directly, per the plan: the
// alternative was duplicating the same construction logic in the test. The returned cleanup releases whatever
// the constructor allocated (a client, a temp file); the caller runs it whether or not it starts the server.
func newStore(ctx context.Context, name string) (anyonce.Store, func(), error) {
	switch name {
	case "", "memory":
		return memory.New(), func() {}, nil
	case "dynamodb":
		return newDynamoDBStore(ctx)
	case "redis":
		return newRedisStore(ctx)
	case "postgres":
		return newPostgresStore(ctx)
	case "sqlite":
		return newSQLiteStore(ctx)
	default:
		return nil, nil, fmt.Errorf("unknown store %q, want memory, dynamodb, redis, postgres or sqlite", name)
	}
}

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address, port 0 picks a free port")
	idempotent := flag.Bool("idempotent", false, "mount httpmw with -store in front of the fixture routes")
	storeName := flag.String("store", "memory",
		"store behind httpmw when -idempotent is set: memory, dynamodb, redis, postgres or sqlite")
	ttlMs := flag.Int("ttl-ms", 2000, "record TTL in milliseconds when -idempotent is set")
	flag.Parse()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen %s: %v", *addr, err)
	}
	fmt.Printf("listening on http://%s\n", ln.Addr().String())

	f := fixture.New()
	handler := f.Handler()
	cleanup := func() {}
	if *idempotent {
		store, storeCleanup, err := newStore(context.Background(), *storeName)
		if err != nil {
			log.Fatalf("build store %q: %v", *storeName, err)
		}
		cleanup = storeCleanup
		// SIGKILL cannot be caught, so this is best effort; it covers the ordinary case of a test harness or an
		// operator stopping the process with SIGINT or SIGTERM, which is when a leaked sqlite temp file would
		// otherwise accumulate.
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		go func() {
			<-sigCh
			cleanup()
			os.Exit(0)
		}()
		mw := httpmw.New(store, httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: time.Duration(*ttlMs) * time.Millisecond}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		handler = mux
	}
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		// log.Fatalf skips deferred calls, so the cleanup runs here explicitly. Without it a Serve that fails
		// after the store was built leaks the sqlite temp files the signal path would have removed.
		cleanup()
		log.Fatalf("serve: %v", err)
	}
}
