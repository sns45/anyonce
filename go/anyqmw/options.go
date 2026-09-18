package anyqmw

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyq/go/core"
)

// KeySource selects where the identity comes from (REQ-Q-1). Q40: only KeySourceBody survives an anyq park on every
// adapter, because a parked message is republished and the broker id changes.
type KeySource string

// KeySourceID, KeySourceHeader and KeySourceBody are the three key sources. KeySourceID is the default.
const (
	// KeySourceID is the broker message id, core.Message.ID.
	KeySourceID KeySource = "id"
	// KeySourceHeader is a message header, named by Options.KeyHeader and matched case-insensitively.
	KeySourceHeader KeySource = "header"
	// KeySourceBody is the body fingerprint, so a re-published message keeps its identity.
	KeySourceBody KeySource = "body"
)

// DefaultKeyHeader is the header a producer sets when the broker id is not stable (REQ-DOC-1, Q4).
const DefaultKeyHeader = "idempotency-key"

// InFlightMode selects what Wrap does with a duplicate whose first claim is still running (D15).
type InFlightMode string

// InFlightRetry and InFlightAck are the two in-flight modes. InFlightRetry is the default.
const (
	// InFlightRetry returns an *InFlightError so the companion Strategy parks the delivery for the lease remainder.
	InFlightRetry InFlightMode = "retry"
	// InFlightAck treats the duplicate as handled. That is an at-most-once-per-lease trade-off: the first claim
	// may still fail after this delivery was acked away.
	InFlightAck InFlightMode = "ack"
)

// Options configures Wrap. Zero values take the documented defaults.
type Options struct {
	// Store is the claim store. It is the one required field: Wrap panics when it is nil.
	Store anyonce.Store
	// Key selects the identity source (REQ-Q-1). Default KeySourceID. KeyFunc overrides it.
	Key KeySource
	// KeyFunc derives the identity from the message itself and wins over Key. Its result is validated like any
	// other key.
	KeyFunc func(core.Message) (string, error)
	// KeyHeader is the header read under KeySourceHeader, matched case-insensitively. Default
	// DefaultKeyHeader.
	KeyHeader string
	// Scope replaces the scope derived from the adapter metadata (Q42). ScopeFunc overrides it.
	Scope string
	// ScopeFunc derives the scope from the message and wins over Scope.
	ScopeFunc func(core.Message) (string, error)
	// ConsumerGroup is appended to the derived queue name as queue/group, overriding the group the adapter
	// reports. It is ignored once Scope or ScopeFunc is set.
	ConsumerGroup string
	// Fingerprint hashes the payload (D9). Default SHA-256 over the raw body bytes.
	Fingerprint func(core.Message) (string, error)
	// OnInFlight is D15: InFlightRetry (default) returns an *InFlightError, InFlightAck returns nil.
	OnInFlight InFlightMode
	// Policy is the engine policy (lease, TTL, cap, StoreResult, OnStoreError, Clock, Hooks). Zero values take
	// anyonce.DefaultPolicy values, except Clock, which Wrap needs and defaults to time.Now.
	Policy anyonce.Policy
	// Warn receives the single one-time warning Wrap emits when no strategy translated an *InFlightError
	// (REQ-Q-8). Default log.Printf, the only logging in the module.
	Warn func(string)
}

// withDefaults returns a copy of o with every documented default applied. Wrap calls it once, so a delivery
// never pays for the defaulting.
func (o Options) withDefaults() Options {
	if o.Key == "" {
		o.Key = KeySourceID
	}
	if o.KeyHeader == "" {
		o.KeyHeader = DefaultKeyHeader
	}
	if o.Fingerprint == nil {
		// D9 for Go: core.Message.Body is raw bytes, so the fingerprint is the hash of those bytes. No
		// canonicalization happens on this side.
		o.Fingerprint = func(msg core.Message) (string, error) { return anyonce.SHA256Hex(msg.Body()), nil }
	}
	if o.OnInFlight == "" {
		o.OnInFlight = InFlightRetry
	}
	if o.Policy.Clock == nil {
		o.Policy.Clock = time.Now
	}
	if o.Warn == nil {
		o.Warn = func(message string) { log.Print(message) }
	}
	return o
}

// operation builds the engine Operation for one delivery: the derived scope, the resolved identity and the
// payload fingerprint. Every failure reaches the caller unchanged, so a configuration mistake is never silently
// turned into a different identity.
func (o Options) operation(msg core.Message) (anyonce.Operation, error) {
	scope, err := o.resolveScope(msg)
	if err != nil {
		return anyonce.Operation{}, err
	}
	key, err := o.resolveKey(msg)
	if err != nil {
		return anyonce.Operation{}, err
	}
	fingerprint, err := o.Fingerprint(msg)
	if err != nil {
		return anyonce.Operation{}, err
	}
	return anyonce.Operation{Scope: scope, Key: key, Fingerprint: fingerprint}, nil
}

// resolveKey applies REQ-Q-1 and validates the result with anyonce.ValidateKey. A key the store cannot hold is
// a configuration error, never a silently truncated or rewritten identity. The error names the source and the
// reason, never the key value (NFR-2).
func (o Options) resolveKey(msg core.Message) (string, error) {
	var key string
	switch {
	case o.KeyFunc != nil:
		derived, err := o.KeyFunc(msg)
		if err != nil {
			return "", err
		}
		key = derived
	case o.Key == KeySourceBody:
		key = anyonce.SHA256Hex(msg.Body())
	case o.Key == KeySourceHeader:
		found, ok := headerValue(msg.Headers(), o.KeyHeader)
		if !ok {
			return "", fmt.Errorf("%w: key source %q found no %s header on this message", ErrConfiguration, o.Key, o.KeyHeader)
		}
		key = found
	case o.Key == KeySourceID:
		key = msg.ID()
	default:
		return "", fmt.Errorf("%w: unknown key source %q", ErrConfiguration, o.Key)
	}
	// allowSpace is false: a space is only ever legal inside an HTTP sf-string, and no broker id carries one.
	if err := anyonce.ValidateKey(key, false); err != nil {
		return "", fmt.Errorf("%w: %v", ErrConfiguration, err)
	}
	return key, nil
}

// resolveScope is the queue half of D8's scope (Q42). An explicit ScopeFunc or Scope wins; otherwise the scope
// comes from what the adapter actually put on the message.
func (o Options) resolveScope(msg core.Message) (string, error) {
	if o.ScopeFunc != nil {
		return o.ScopeFunc(msg)
	}
	if o.Scope != "" {
		return o.Scope, nil
	}
	metadata := msg.Metadata()
	queue, group := queueName(metadata)
	if queue == "" {
		return "", fmt.Errorf("%w: the %s adapter does not name its queue on the message; set Options.Scope", ErrConfiguration, metadata.Provider)
	}
	if o.ConsumerGroup != "" {
		group = o.ConsumerGroup
	}
	if group == "" {
		return queue, nil
	}
	return queue + "/" + group, nil
}

// queueName reads the queue and the consumer group out of the adapter's own metadata, one arm per provider, the
// same table the TypeScript queueName uses. An empty queue means the adapter names none on the message, which
// is the rabbitmq, sns and azure-servicebus case.
func queueName(metadata core.ProviderMetadata) (queue, group string) {
	switch metadata.Provider {
	case core.DriverMemory:
		if metadata.Memory != nil {
			return metadata.Memory.QueueName, ""
		}
	case core.DriverRedisStreams:
		if metadata.RedisStreams != nil {
			return metadata.RedisStreams.Stream, metadata.RedisStreams.ConsumerGroup
		}
	case core.DriverSQS:
		if metadata.SQS != nil {
			return metadata.SQS.QueueURL, ""
		}
	case core.DriverKafka:
		if metadata.Kafka != nil {
			return metadata.Kafka.Topic, ""
		}
	case core.DriverPgmq:
		if metadata.Pgmq != nil {
			return metadata.Pgmq.QueueName, ""
		}
	case core.DriverNATS:
		if metadata.NATS != nil {
			return metadata.NATS.Stream, ""
		}
	case core.DriverGooglePubSub:
		if metadata.GooglePubSub != nil {
			return metadata.GooglePubSub.Subscription, ""
		}
	}
	return "", ""
}

// headerValue finds a header case-insensitively. anyq header values are bytes, because several brokers carry
// binary header values, so the match decodes before returning.
func headerValue(headers core.MessageHeaders, name string) (string, bool) {
	for field, value := range headers {
		if strings.EqualFold(field, name) {
			return string(value), true
		}
	}
	return "", false
}
