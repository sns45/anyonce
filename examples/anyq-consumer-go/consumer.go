package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/memory"
)

// order is the message body the producer publishes.
type order struct {
	OrderID string `json:"orderId"`
	Total   int    `json:"total"`
}

// keyHeader is the header the producer sets on every message and the consumer keys on (Q4, Q40).
const keyHeader = anyqmw.DefaultKeyHeader

// config is what newConsumer needs. A nil onOrder logs the order id; a zero policy keeps the anyonce defaults.
type config struct {
	queueName string
	store     anyonce.Store
	onOrder   func(context.Context, order) error
	// policy carries the lease (how long a parked duplicate waits) and the engine hooks.
	policy anyonce.Policy
	// quiet turns anyq's own logging off.
	quiet bool
}

// newConsumer builds an anyq memory consumer and the handler to subscribe on it. Both halves are required
// wiring: anyqmw.Wrap reports an in-flight duplicate or a payload mismatch as a typed error, and only the
// consumer's strategy, anyqmw.Strategy, can turn that into a park for the lease remainder or a dead letter,
// because anyq reaches its delay and dead-letter primitives through a strategy decision alone.
func newConsumer(cfg config) (*memory.Consumer, core.Handler) {
	onOrder := cfg.onOrder
	if onOrder == nil {
		onOrder = func(_ context.Context, o order) error {
			log.Printf("handled order %s", o.OrderID)
			return nil
		}
	}
	var logging *core.LogConfig
	if cfg.quiet {
		logging = &core.LogConfig{Enabled: false}
	}
	consumer := memory.NewConsumer(memory.Config{
		BaseQueueConfig: core.BaseQueueConfig{
			Driver:   core.DriverMemory,
			Logging:  logging,
			Strategy: anyqmw.Strategy(nil),
		},
		QueueName: cfg.queueName,
	})
	handler := anyqmw.Wrap(func(ctx context.Context, msg core.Message) error {
		var o order
		if err := json.Unmarshal(msg.Body(), &o); err != nil {
			return fmt.Errorf("decode order: %w", err)
		}
		return onOrder(ctx, o)
	}, anyqmw.Options{
		Store: cfg.store,
		// KeySourceHeader because a park re-enqueues the message with a fresh id on the memory adapter (Q40).
		Key:    anyqmw.KeySourceHeader,
		Policy: cfg.policy,
	})
	return consumer, handler
}
