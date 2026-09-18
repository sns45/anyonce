# anyq consumer interfaces (read from source, 2026-09-16)

Source of truth: `sns45/anyq` at `b49d41f` (release 0.5.0). TypeScript from `packages/core/src`, Go from `go/core`. The queue adapter in requirements section 4.5 is written against the shapes below, not the illustrative ones.

## 1. TypeScript (`@anyq/core` 0.5.0)

### Handler and message

```ts
// packages/core/src/types/consumer.ts
export type MessageHandler<T = unknown> = (message: IMessage<T>) => Promise<void>;
export type BatchMessageHandler<T = unknown> = (messages: IMessage<T>[]) => Promise<void>;

export interface SubscribeOptions {
  fromBeginning?: boolean;
  fromTimestamp?: Date;
  concurrency?: number;      // default 1
  autoAck?: boolean;         // default true
  batchSize?: number;        // default 10
  batchTimeout?: number;     // default 1000
}

export interface IConsumer<T = unknown> extends IConsumerEventEmitter<T> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  subscribe(handler: MessageHandler<T>, options?: SubscribeOptions): Promise<void>;
  subscribeBatch(handler: BatchMessageHandler<T>, options?: SubscribeOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  isPaused(): boolean;
  seek?(position: SeekPosition): Promise<void>;
  getLag?(): Promise<ConsumerLag>;
  healthCheck(): Promise<HealthStatus>;
}
```

```ts
// packages/core/src/types/message.ts
export type MessageHeaders = Record<string, string | Buffer | undefined>;

export interface IMessage<T = unknown> {
  readonly id: string;                 // broker message id (always present)
  readonly body: T;                    // already deserialized (JsonSerializer by default)
  readonly key?: string;
  readonly headers: MessageHeaders;
  readonly timestamp: Date;
  readonly deliveryAttempt: number;    // 1-based
  readonly metadata: ProviderMetadata; // { provider: QueueDriver, kafka?, sqs?, redisStreams?, memory?, ... }
  ack(): Promise<void>;
  nack(requeue?: boolean): Promise<void>;
  extendDeadline?(seconds: number): Promise<void>;  // SQS, Pub/Sub, Service Bus, NATS only
  readonly raw: unknown;
}

export type QueueDriver =
  | 'memory' | 'redis-streams' | 'rabbitmq' | 'sqs' | 'sns' | 'google-pubsub'
  | 'kafka' | 'nats' | 'azure-servicebus' | 'cloudflare-queues' | 'pgmq';
```

Consequences for anyonce:

- The wrapped handler has exactly the `MessageHandler<T>` signature. `idempotent(handler, opts)` returns a `MessageHandler<T>`.
- There is no raw body byte access on `IMessage`. `body` is the deserialized value and `raw` is provider specific. The queue fingerprint in TS cannot be "SHA-256 over body bytes" as D9 states. See `docs/superpowers/questions.md` Q3.
- Message id is always present (`id: string`), so REQ-Q-1's default key order collapses to: `message.id`, unless the caller overrides `key`. The `idempotency-key` header fallback still exists for callers who publish with their own key.
- Headers values may be `Buffer`, so a header-derived key must be normalized to string.

### Ack and nack semantics

Every consumer (`memory`, `redis-streams`, `sqs`, `kafka`) runs the same loop:

```ts
try {
  this.emit('message', message);
  await handler(message);
  if (opts.autoAck) await message.ack();     // default true
} catch (error) {
  const result = await this.applyStrategy(message, err, () => handler(message));
  if (!result.handled) {
    // legacy path, no strategy configured:
    // memory: DLQ after deadLetterQueue.maxDeliveryAttempts (default 3), else nack(true)
    // others: nack(true) or adapter specific
  }
}
```

So for a wrapped handler:

| Wrapped handler does | Consumer does |
|---|---|
| returns normally | `ack()` (autoAck) |
| throws | `applyStrategy(...)`; without a strategy, legacy requeue or DLQ after N attempts |

"Return success to the broker without running the handler" (D15 completed duplicate) is therefore: return without calling the inner handler.

### Dead-letter and delay are consumer hooks, not message methods

There is no `message.deadLetter()` and no `message.delay()`. Both live on `BaseConsumer` as protected hooks and are reachable only through a `RetryDecision` returned by the configured `strategy`:

```ts
// packages/core/src/strategies/types.ts
export type RetryDecision =
  | { action: 'ack' }
  | { action: 'retry'; delayMs: number }       // in-process sleep then reinvoke, capped by maxAttempts
  | { action: 'requeue' }                      // nack(true)
  | { action: 'deadLetter'; reason: string }   // BaseConsumer.deadLetterMessage(message, reason)
  | { action: 'park'; delayMs: number }        // BaseConsumer.parkMessage(message, delayMs) if supportsNativeDelay, else downgrades to 'retry'
  | { action: 'fail' };                        // rethrow, crash the loop

export interface RetryStrategyContext<T = unknown> {
  message: IMessage<T>;
  error: Error;
  attempt: number;      // mirrors message.deliveryAttempt, incremented on in-process retries
  maxAttempts: number;  // deadLetterQueue.maxDeliveryAttempts, else retry.maxRetries + 1, else 4
}

export interface RetryStrategy<T = unknown> {
  readonly name: string;
  decide(ctx: RetryStrategyContext<T>): RetryDecision | Promise<RetryDecision>;
}
```

Configured on the consumer: `BaseQueueConfig.strategy?: BaseRetryStrategy`. Built-ins in `@anyq/core/strategies`: `logAndSkip()`, `logAndFail()`, `retryThenDeadLetter(opts)`, `deadLetterImmediate()`, `backpressurePause(opts)`, `custom(name, decide)`.

Hook implementations per adapter (TS):

| Adapter | `supportsNativeDelay` | `deadLetterMessage` override | `parkMessage` override |
|---|---|---|---|
| memory | true | yes, routes to configured DLQ via `MemoryQueue.deadLetter()`; no DLQ: `nack(false)` | yes, `setTimeout` re-enqueue |
| redis-streams | false (default) | no, default: warn and `nack(false)` | no, `park` downgrades to in-process retry |
| sqs | true | no, default: warn and `nack(false)` (rely on SQS redrive policy) | yes, `ChangeMessageVisibility` style delay |
| kafka | false (default) | no, default: warn and `nack(false)` | no, `park` downgrades to in-process retry |

Consequences for anyonce (REQ-Q-2, REQ-Q-4):

- The middleware cannot call dead-letter directly. It throws typed errors and ships a companion strategy that maps them to decisions. Design recorded in `docs/superpowers/questions.md` Q2:
  - in-flight duplicate with `onInFlight: 'retry'` throws `InFlightError { leaseUntil, delayMs }`; the companion strategy returns `{ action: 'park', delayMs }`. On adapters without native delay anyq downgrades this to an in-process sleep and reinvoke, which re-enters `begin` after the lease. That is acceptable and documented.
  - mismatch throws `FingerprintMismatchError { record }`; the companion strategy returns `{ action: 'deadLetter', reason: 'fingerprint-mismatch' }`. REQ-Q-4's "if the adapter cannot dead-letter, rethrow" is satisfied by construction: if no strategy is configured, the typed error reaches anyq's legacy path.
  - handler exceptions are rethrown unchanged (REQ-Q-3); the companion strategy delegates every non-anyonce error to an inner strategy the caller supplies (default `retryThenDeadLetter()`).
- `allowParkDowngrade === false` on the consumer makes `park` on kafka or redis-streams a startup `ConfigurationError`. The anyonce docs must mention this for the `retry` mode.

### Errors

`AnyQError` carries `code`, `retryable`, `cause`, `details`. `isRetryableError(err)` returns `err.retryable` for `AnyQError` instances. anyonce's typed errors should extend `Error` (not `AnyQError`, to avoid a runtime dependency on `@anyq/core`) and expose `retryable` structurally so the default predicate still works if a caller uses `retryThenDeadLetter` without the companion strategy.

## 2. Go (`github.com/sns45/anyq/go` at `go/v0.5.0`, `go 1.25.3`)

### Handler and message

```go
// go/core/consumer.go
type Handler func(ctx context.Context, msg Message) error
type BatchHandler func(ctx context.Context, msgs []Message) error

type SubscribeOptions struct {
    FromBeginning bool
    FromTimestamp *time.Time
    Concurrency   int
    AutoAck       *bool          // nil means true
    BatchSize     int
    BatchTimeout  time.Duration
}

type Consumer interface {
    Connect(ctx context.Context) error
    Disconnect(ctx context.Context) error
    IsConnected() bool
    Subscribe(ctx context.Context, handler Handler, opts *SubscribeOptions) error
    SubscribeBatch(ctx context.Context, handler BatchHandler, opts *SubscribeOptions) error
    Pause(ctx context.Context) error
    Resume(ctx context.Context) error
    IsPaused() bool
    HealthCheck(ctx context.Context) (HealthStatus, error)
}
```

```go
// go/core/message.go
type MessageHeaders map[string][]byte

type Message interface {
    ID() string
    Body() []byte                 // raw bytes, decoding is the handler's concern
    Key() string
    Headers() MessageHeaders
    Timestamp() time.Time
    DeliveryAttempt() int         // 1-based
    Metadata() ProviderMetadata
    Ack(ctx context.Context) error
    Nack(ctx context.Context, requeue bool) error
    ExtendDeadline(ctx context.Context, d time.Duration) error  // ErrNotSupported where unsupported
    Raw() any
}
```

Consequences: `anyqmw.Wrap(handler core.Handler, opts Options) core.Handler`. `Body()` is raw bytes, so the Go queue fingerprint is SHA-256 over `Body()` exactly as D9 says. The wrapped handler receives the subscription `ctx`; cancellation is observable via `ctx.Done()` (REQ-Q-7 abandons on cancellation).

### Strategy and hooks

```go
// go/core/strategies.go
type Action int
const (
    ActionAck Action = iota
    ActionRetry       // in-process sleep (sleepCtx) then reinvoke
    ActionRequeue     // Nack(ctx, true)
    ActionDeadLetter  // hooks().DeadLetterMessage(ctx, msg, reason)
    ActionPark        // hooks().ParkMessage(ctx, msg, delayMs) if SupportsNativeDelay, else downgrade to retry
    ActionFail        // return the error, crash the loop
)
type Decision struct { Action Action; DelayMs int; Reason string }
func Ack() Decision; func Retry(delayMs int) Decision; func Requeue() Decision
func DeadLetter(reason string) Decision; func Park(delayMs int) Decision; func Fail() Decision

type StrategyContext struct { Message Message; Err error; Attempt int; MaxAttempts int }
type Strategy interface {
    Name() string
    Decide(ctx context.Context, sc StrategyContext) (Decision, error)
}
func Custom(name string, fn func(ctx context.Context, sc StrategyContext) (Decision, error)) Strategy
func LogAndSkip() Strategy; func LogAndFail() Strategy; func DeadLetterImmediate() Strategy
func RetryThenDeadLetter(opts *RetryThenDeadLetterOptions) Strategy
func BackpressurePause(opts *BackpressurePauseOptions) Strategy
```

```go
// go/core/base.go
type ConsumerHooks interface {
    SupportsNativeDelay() bool
    DeadLetterMessage(ctx context.Context, msg Message, reason string) error   // default: warn + Nack(ctx, false)
    ParkMessage(ctx context.Context, msg Message, delayMs int) error          // default: warn + Nack(ctx, true)
    Pause(ctx context.Context) error
    Resume(ctx context.Context) error
}
func (c *BaseConsumer) ApplyStrategy(ctx context.Context, msg Message, handlerErr error, reinvoke func() error) (handled bool, err error)
```

Configured via `BaseQueueConfig.Strategy`. Go defaults to fail-loud on park downgrade (`VerifyParkPolicy` returns a `CONFIGURATION_ERROR`) unless `AllowParkDowngrade` is set; this differs from TS on purpose (documented in anyq).

Adapter overrides (Go):

| Adapter | `SupportsNativeDelay` | `DeadLetterMessage` | `ParkMessage` |
|---|---|---|---|
| memory | true | yes | yes |
| sqs | true | default (warn + nack false) | yes |
| kafka | false | default | default |
| redis | false | default | default |

### Errors

```go
// go/core/errors.go
var ErrNotSupported = errors.New("operation not supported by this adapter")
type AnyQError struct { Message, Code string; Retryable bool; Cause error; Details map[string]any }
func (e *AnyQError) Unwrap() error
func AsAnyQError(err error) (*AnyQError, bool)
```

anyonce Go typed errors: `anyqmw.ErrInFlight` (wrapped with lease info), `anyqmw.ErrFingerprintMismatch`, both matched with `errors.Is`; the companion `anyqmw.Strategy(inner core.Strategy) core.Strategy` maps them to `Park` and `DeadLetter("fingerprint-mismatch")` and delegates everything else to `inner`.

## 3. Test targets for REQ-Q-6

| Adapter | TS package | Go package | Container in `test/compose.yml` |
|---|---|---|---|
| memory | `@anyq/memory` | `go/memory` | none |
| Redis Streams | `@anyq/redis-streams` | `go/redis` | Redis 7 (shared with the Redis store) |
| SQS | `@anyq/sqs` | `go/sqs` | ElasticMQ |
| Kafka | `@anyq/kafka` | `go/kafka` | Redpanda |

## 4. Corrections found against the published packages (2026-09-18)

The sections above were transcribed from the anyq source at `b49d41f`. Two rows do not match the published 0.5.0 artifacts and are corrected here rather than edited above, so the transcription stays verbatim:

- TypeScript adapter table, `sqs` `parkMessage`: the published `@anyq/sqs` 0.5.0 does not change visibility. It acks the received message and publishes a new one with `SendMessage` and `DelaySeconds`, carrying `MessageBody` only, so the parked copy has a new `MessageId` and no message attributes. `@anyq/memory` `parkMessage` likewise re-enqueues and mints a fresh id, keeping `key` and `headers`. See `docs/superpowers/questions.md` Q23.
- Built-in strategies are re-exported from the `@anyq/core` root. The published `exports` map has no `./strategies` subpath.
