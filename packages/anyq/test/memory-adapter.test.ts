import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { ApplyStrategyResult, IMessage, MessageHandler } from '@anyq/core';
import { MemoryConsumer, MemoryProducer, unregisterQueue } from '@anyq/memory';
import { InFlightError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';
import { idempotent } from '../src/idempotent';
import { idempotencyStrategy } from '../src/strategy';

/**
 * REQ-Q-6 and REQ-Q-8 against the in-process anyq adapter. The memory consumer is the one adapter in this
 * repository's test matrix with a working native park, so the park case here is the end to end native park:
 * anyq re-enqueues the message after the delay and the door's second claim succeeds once the lease has gone.
 * Q40: that re-enqueue mints a fresh message id, which is why every test in this file keys on a header.
 */

/** applyStrategy, parkMessage and deadLetterMessage are protected on BaseConsumer; this widens what a test drives. */
class Probe<T> extends MemoryConsumer<T> {
  readonly deadLetters: Array<{ id: string; reason: string }> = [];

  runStrategy(
    message: IMessage<T>,
    error: Error,
    reinvoke?: () => Promise<void>,
  ): Promise<ApplyStrategyResult> {
    return this.applyStrategy(message, error, reinvoke);
  }

  runPark(message: IMessage<T>, delayMs: number): Promise<void> {
    return this.parkMessage(message, delayMs);
  }

  protected override async deadLetterMessage(message: IMessage<T>, reason: string): Promise<void> {
    this.deadLetters.push({ id: message.id, reason });
    await super.deadLetterMessage(message, reason);
  }
}

/** Counts deliveries and hands out a promise per count, so no test waits on a duration. */
function deliveries() {
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
  };
}

interface Driven {
  ids: string[];
  errors: Error[];
  results: ApplyStrategyResult[];
}

/**
 * The shape of every anyq consumer's catch block: run the handler, and on a throw hand the error to the
 * strategy with a re-invocation of the same handler. Driving it here keeps the ApplyStrategyResult, which the
 * adapter's own loop discards.
 */
function drive<T>(
  probe: Probe<T>,
  wrapped: MessageHandler<T>,
  seen: Driven,
  settled: { hit(): void },
): MessageHandler<T> {
  return async (message: IMessage<T>): Promise<void> => {
    seen.ids.push(message.id);
    let disposed = false;
    try {
      await wrapped(message);
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      seen.errors.push(error);
      const result = await probe.runStrategy(message, error, () => wrapped(message));
      seen.results.push(result);
      disposed = result.handled;
    }
    // anyq acknowledges only a delivery the handler completed. Once the strategy has handled the failure it has
    // already decided the message's fate, so acknowledging here too would be a second call for one delivery.
    if (!disposed) await message.ack();
    settled.hit();
  };
}

function record(): Driven {
  return { ids: [], errors: [], results: [] };
}

const QUIET = { logging: { enabled: false } } as const;

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

function queueFor(label: string): string {
  return `anyonce-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function start<T>(
  queueName: string,
  consumer: MemoryConsumer<T>,
): Promise<MemoryProducer<T>> {
  const producer = new MemoryProducer<T>({ driver: 'memory', queueName, ...QUIET });
  await producer.connect();
  await consumer.connect();
  cleanup.push(async () => {
    await consumer.disconnect();
    await producer.disconnect();
    unregisterQueue(queueName);
  });
  return producer;
}

describe('memory adapter through the door', () => {
  test('REQ-Q-6: a memory consumer runs a wrapped handler once for a redelivered message', async () => {
    const queueName = queueFor('memory-once');
    const consumer = new MemoryConsumer<{ orderId: string }>({
      driver: 'memory',
      queueName,
      ...QUIET,
    });
    const producer = await start(queueName, consumer);

    const store = new MemoryStore();
    const handled: Array<{ orderId: string }> = [];
    // The redelivery is a producer that sent the same work twice: two queue messages with fresh ids, one
    // producer supplied key and byte identical bodies, which is the case the id key source cannot catch.
    const wrapped = idempotent<{ orderId: string }>(
      async (message) => {
        handled.push(message.body);
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const settled = deliveries();
    await consumer.subscribe(
      async (message) => {
        await wrapped(message);
        await message.ack();
        settled.hit();
      },
      { autoAck: false },
    );

    const headers = { 'idempotency-key': `mem-${queueName}` };
    await producer.publish({ orderId: 'a-1' }, { headers });
    await producer.publish({ orderId: 'a-1' }, { headers });
    await settled.reaches(2);

    expect(handled).toEqual([{ orderId: 'a-1' }]);
    expect(consumer.getQueue()?.size()).toBe(0);
    expect(consumer.getQueue()?.processingCount()).toBe(0);
  }, 30_000);

  test('REQ-Q-8: with the strategy configured, an in-flight duplicate parks and the handler waits for the lease', async () => {
    const queueName = queueFor('memory-park');
    const probe = new Probe<{ orderId: string }>({
      driver: 'memory',
      queueName,
      strategy: idempotencyStrategy(),
      ...QUIET,
    });
    const producer = await start(queueName, probe);

    const store = new MemoryStore();
    const body = { orderId: 'b-1' };
    const key = `mem-${queueName}`;
    const claimedAt = Date.now();
    const leaseMs = 300;
    const leaseUntil = claimedAt + leaseMs;
    const claim = await store.begin(
      { scope: queueName, key, fingerprint: await messageFingerprint(body) },
      { leaseMs, ttlMs: 60_000, now: claimedAt },
    );
    expect(claim.outcome).toBe('acquired');

    let ran = 0;
    let firstCallAt = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
        if (ran === 1) firstCallAt = Date.now();
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    await producer.publish(body, { headers: { 'idempotency-key': key } });
    await settled.reaches(2);

    expect(seen.errors[0]).toBeInstanceOf(InFlightError);
    expect(seen.results[0]).toEqual({ handled: true });
    expect(ran).toBe(1);
    expect(firstCallAt).toBeGreaterThanOrEqual(leaseUntil);
    expect(probe.deadLetters).toEqual([]);
  }, 30_000);

  test('REQ-Q-8: with the strategy configured, a payload mismatch dead-letters with reason fingerprint-mismatch', async () => {
    const queueName = queueFor('memory-mismatch');
    const probe = new Probe<{ orderId: string; total: number }>({
      driver: 'memory',
      queueName,
      strategy: idempotencyStrategy(),
      ...QUIET,
    });
    const producer = await start(queueName, probe);

    const store = new MemoryStore();
    let ran = 0;
    const wrapped = idempotent<{ orderId: string; total: number }>(
      async () => {
        ran += 1;
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    const headers = { 'idempotency-key': `mem-${queueName}` };
    await producer.publish({ orderId: 'c-1', total: 1 }, { headers });
    await settled.reaches(1);
    await producer.publish({ orderId: 'c-1', total: 2 }, { headers });
    await settled.reaches(2);

    expect(ran).toBe(1);
    expect(seen.results).toEqual([{ handled: true }]);
    expect(probe.deadLetters).toEqual([
      { id: seen.ids[1] as string, reason: 'fingerprint-mismatch' },
    ]);
  }, 30_000);

  test('REQ-Q-8: with no strategy the typed error reaches anyq legacy handling untranslated', async () => {
    const queueName = queueFor('memory-untranslated');
    const probe = new Probe<{ orderId: string }>({ driver: 'memory', queueName, ...QUIET });
    const producer = await start(queueName, probe);

    const store = new MemoryStore();
    const body = { orderId: 'd-1' };
    const key = `mem-${queueName}`;
    const claim = await store.begin(
      { scope: queueName, key, fingerprint: await messageFingerprint(body) },
      { leaseMs: 60_000, ttlMs: 60_000, now: Date.now() },
    );
    expect(claim.outcome).toBe('acquired');

    let ran = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    await producer.publish(body, { headers: { 'idempotency-key': key } });
    await settled.reaches(1);

    expect(ran).toBe(0);
    expect(seen.results).toEqual([{ handled: false }]);
    const error = seen.errors[0];
    expect(error).toBeInstanceOf(InFlightError);
    expect((error as InFlightError).translated).toBe(false);
    expect(probe.deadLetters).toEqual([]);
  }, 30_000);

  test('REQ-Q-1: an anyq park re-enqueues with a fresh message id, which the id key source cannot follow (Q40)', async () => {
    const queueName = queueFor('memory-park-id');
    const probe = new Probe<{ orderId: string }>({ driver: 'memory', queueName, ...QUIET });
    const producer = await start(queueName, probe);

    const seen: Array<IMessage<{ orderId: string }>> = [];
    const settled = deliveries();
    await probe.subscribe(
      async (message) => {
        seen.push(message);
        if (seen.length === 1) await probe.runPark(message, 20);
        else await message.ack();
        settled.hit();
      },
      { autoAck: false },
    );

    const key = `mem-${queueName}`;
    await producer.publish({ orderId: 'e-1' }, { headers: { 'idempotency-key': key } });
    await settled.reaches(2);

    const first = seen[0] as IMessage<{ orderId: string }>;
    const second = seen[1] as IMessage<{ orderId: string }>;
    expect(second.id).not.toBe(first.id);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotency-key']).toBe(key);
  }, 30_000);
});
