import { afterEach, describe, expect, test } from 'bun:test';
import { InFlightError, messageFingerprint } from '@anyonce/anyq';
import { MemoryStore, type Store } from '@anyonce/core';
import { MemoryProducer, unregisterQueue } from '@anyq/memory';
import { createConsumer, KEY_HEADER, type Order } from '../src/consumer';

/** A counting barrier: a test waits for a number of events, never for a duration. */
function barrier(): { hit(): void; reaches(at: number): Promise<void>; count(): number } {
  let hits = 0;
  const waiters: Array<{ at: number; resolve: () => void }> = [];
  return {
    hit(): void {
      hits += 1;
      for (const waiter of waiters) if (hits >= waiter.at) waiter.resolve();
    },
    reaches(at: number): Promise<void> {
      return new Promise<void>((resolve) => {
        if (hits >= at) resolve();
        else waiters.push({ at, resolve });
      });
    },
    count: () => hits,
  };
}

/** A store that signals once a claim is completed, which is when a delivery's handler has finished for good. */
function completing(inner: Store, completed: { hit(): void }): Store {
  return {
    begin: (...args) => inner.begin(...args),
    complete: async (...args) => {
      const status = await inner.complete(...args);
      completed.hit();
      return status;
    },
    abandon: (...args) => inner.abandon(...args),
    get: (...args) => inner.get(...args),
    purge: (...args) => inner.purge(...args),
  };
}

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

function queueFor(label: string): string {
  return `orders-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function producerFor(queueName: string): Promise<MemoryProducer<Order>> {
  const producer = new MemoryProducer<Order>({
    driver: 'memory',
    queueName,
    logging: { enabled: false },
  });
  await producer.connect();
  cleanup.push(async () => {
    await producer.disconnect();
    unregisterQueue(queueName);
  });
  return producer;
}

describe('anyq-consumer-ts', () => {
  test('REQ-DOC-7: anyq-consumer-ts runs the handler once for a redelivered message', async () => {
    const queueName = queueFor('once');
    const memory = new MemoryStore();
    const completed = barrier();
    const replayed = barrier();
    const handled: Order[] = [];
    const producer = await producerFor(queueName);
    const consumer = await createConsumer({
      queueName,
      store: completing(memory, completed),
      onOrder: (order) => {
        handled.push(order);
      },
      hooks: { onReplayed: () => replayed.hit() },
      quiet: true,
    });
    cleanup.push(() => consumer.disconnect());

    const order: Order = { orderId: 'o-1', total: 42 };
    const headers = { [KEY_HEADER]: `order-${queueName}` };
    await producer.publish(order, { headers });
    await completed.reaches(1);
    // The same order again under the same key: what a redelivery or a producer retry looks like to the
    // consumer. anyq mints a fresh message id for it, so only the header ties the two together.
    await producer.publish(order, { headers });
    await replayed.reaches(1);

    expect(handled).toEqual([order]);
    expect(completed.count()).toBe(1);
    const record = await memory.get({ scope: queueName, key: `order-${queueName}` }, Date.now());
    expect(record?.state).toBe('completed');
  }, 30_000);

  test('REQ-Q-8: anyq-consumer-ts wires idempotent and idempotencyStrategy together and an in-flight duplicate parks without running the handler before the lease expires', async () => {
    const queueName = queueFor('park');
    const memory = new MemoryStore();
    const completed = barrier();
    const producer = await producerFor(queueName);

    // Another consumer holds a live claim on this order when the delivery arrives.
    const order: Order = { orderId: 'o-2', total: 7 };
    const key = `order-${queueName}`;
    const claimedAt = Date.now();
    const leaseMs = 300;
    const leaseUntil = claimedAt + leaseMs;
    const claim = await memory.begin(
      { scope: queueName, key, fingerprint: await messageFingerprint(order) },
      { leaseMs, ttlMs: 60_000, now: claimedAt },
    );
    expect(claim.outcome).toBe('acquired');

    const runs: number[] = [];
    let conflicts = 0;
    const consumer = await createConsumer({
      queueName,
      store: completing(memory, completed),
      onOrder: () => {
        runs.push(Date.now());
      },
      hooks: { onConflict: () => (conflicts += 1) },
      quiet: true,
    });
    cleanup.push(() => consumer.disconnect());
    const errors: unknown[] = [];
    consumer.on('error', (error) => errors.push(error));

    await producer.publish(order, { headers: { [KEY_HEADER]: key } });
    // The claim completing is the end of the park: anyq re-enqueued the message after the delay and the
    // door's second claim found the lease gone.
    await completed.reaches(1);

    // The park delay is whole milliseconds, so a redelivery can land just before the lease and park once
    // more. What matters is the handler: it ran once, and not before the lease expired.
    expect(conflicts).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBe(conflicts);
    for (const error of errors) {
      expect(error).toBeInstanceOf(InFlightError);
      // The strategy marks every in-flight error it turns into a park; without it the flag stays false.
      expect((error as InFlightError).translated).toBe(true);
    }
    expect(runs).toHaveLength(1);
    expect(runs[0] as number).toBeGreaterThanOrEqual(leaseUntil);
    expect((await memory.get({ scope: queueName, key }, Date.now()))?.state).toBe('completed');
  }, 30_000);
});
