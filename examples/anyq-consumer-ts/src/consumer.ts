import { type IdempotentOptions, idempotencyStrategy, idempotent } from '@anyonce/anyq';
import { type ExecuteHooks, MemoryStore, type Store } from '@anyonce/core';
import { MemoryConsumer, MemoryProducer } from '@anyq/memory';

/** The message body this consumer handles. */
export interface Order {
  orderId: string;
  total: number;
}

/** The header the producer sets on every message; the consumer keys on it (Q4, Q40). */
export const KEY_HEADER = 'idempotency-key';

export interface ConsumerDeps {
  queueName: string;
  store: Store;
  /** Runs at most once per idempotency-key while the record lives. Default: logs the order id. */
  onOrder?: (order: Order) => void | Promise<void>;
  /** The claim lease, which is how long a parked duplicate waits. Default: the anyonce default. */
  leaseMs?: number;
  /** Engine hooks (acquired, replayed, conflict, mismatch, store error), the observability path. */
  hooks?: ExecuteHooks;
  /** Turns anyq's own logging off. */
  quiet?: boolean;
}

/**
 * Connects an anyq memory consumer and subscribes the wrapped handler. Both halves are required wiring: the
 * door (`idempotent`) reports an in-flight duplicate or a payload mismatch as a typed error, and only the
 * consumer's strategy (`idempotencyStrategy`) can turn that into a park for the lease remainder or a dead
 * letter, because anyq reaches its delay and dead-letter primitives through a strategy decision alone.
 */
export async function createConsumer(deps: ConsumerDeps): Promise<MemoryConsumer<Order>> {
  const onOrder = deps.onOrder ?? ((order: Order) => console.log(`handled order ${order.orderId}`));
  const consumer = new MemoryConsumer<Order>({
    driver: 'memory',
    queueName: deps.queueName,
    strategy: idempotencyStrategy(),
    ...(deps.quiet === true ? { logging: { enabled: false } } : {}),
  });
  // key: 'header' because a park re-enqueues the message with a fresh id on the memory adapter (Q40).
  const options: IdempotentOptions<Order> = { store: deps.store, key: 'header' };
  if (deps.leaseMs !== undefined) options.leaseMs = deps.leaseMs;
  if (deps.hooks !== undefined) options.hooks = deps.hooks;

  await consumer.connect();
  await consumer.subscribe(
    idempotent<Order>(async (message) => {
      await onOrder(message.body);
    }, options),
  );
  return consumer;
}

if (import.meta.main) {
  const queueName = 'orders';
  let replayed: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    replayed = resolve;
  });
  // The memory store keeps this example self contained; production uses a shared store (docs/stores.md).
  const consumer = await createConsumer({
    queueName,
    store: new MemoryStore(),
    hooks: { onReplayed: () => replayed() },
    quiet: true,
  });
  const producer = new MemoryProducer<Order>({
    driver: 'memory',
    queueName,
    logging: { enabled: false },
  });
  await producer.connect();

  const order: Order = { orderId: 'o-1', total: 42 };
  const headers = { [KEY_HEADER]: 'order-o-1' };
  await producer.publish(order, { headers });
  // A producer retry: the same order again, which anyq publishes as a second message with a second id.
  await producer.publish(order, { headers });
  await done;
  console.log('the second delivery replayed; the handler ran once');

  await consumer.disconnect();
  await producer.disconnect();
}
