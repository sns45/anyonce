package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/postgres"
)

// order is what POST /orders creates and returns.
type order struct {
	ID   string `json:"id"`
	Item string `json:"item"`
}

// openStore connects to Postgres and applies the idempotency schema, which is safe to repeat on every start.
func openStore(ctx context.Context, dsn string) (anyonce.Store, error) {
	store, err := postgres.Open(ctx, dsn, postgres.Options{})
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		return nil, fmt.Errorf("ensure schema: %w", err)
	}
	return store, nil
}

// options is the middleware configuration. A zero ttl keeps the anyonce default of 24 hours.
func options(ttl time.Duration) httpmw.Options {
	return httpmw.Options{
		// A POST without Idempotency-Key is a 400 missing-key rather than an unprotected write.
		Required: true,
		Policy:   anyonce.Policy{TTL: ttl},
	}
}

// routes is the service itself, with no idempotency code in it.
func routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Item string `json:"item"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "body must be JSON with an item", http.StatusBadRequest)
			return
		}
		// Runs once per key: a retry with the same key and body gets this exact response back, id included.
		id := make([]byte, 8)
		_, _ = rand.Read(id)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(order{ID: hex.EncodeToString(id), Item: in.Item})
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

// newHandler is what main serves: the routes behind httpmw over the given store.
func newHandler(store anyonce.Store) http.Handler {
	return httpmw.New(store, options(0)).Handler(routes())
}
