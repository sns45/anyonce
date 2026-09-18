import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import { QueueConfigurationError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';
import { resolveKey, resolveOptions, resolveScope } from '../src/options';
import { fakeMessage } from './fake';

const base = { store: new MemoryStore() };

describe('key resolution', () => {
  test('REQ-Q-1: the default key is the broker message id', async () => {
    const resolved = resolveOptions(base);
    const message = fakeMessage({ id: 'sqs-42', body: { a: 1 } });
    await expect(resolveKey(message, resolved)).resolves.toBe('sqs-42');
  });

  test('REQ-Q-1: the header source reads idempotency-key case insensitively and decodes byte values', async () => {
    const resolved = resolveOptions({ ...base, key: 'header' });
    const text = fakeMessage({ body: {}, headers: { 'Idempotency-Key': 'from-producer' } });
    await expect(resolveKey(text, resolved)).resolves.toBe('from-producer');
    const bytes = fakeMessage({
      body: {},
      headers: { 'idempotency-key': new TextEncoder().encode('from-bytes') as unknown as string },
    });
    await expect(resolveKey(bytes, resolved)).resolves.toBe('from-bytes');
  });

  test('REQ-Q-1: a missing header under the header source is a configuration error', async () => {
    const resolved = resolveOptions({ ...base, key: 'header' });
    await expect(resolveKey(fakeMessage({ body: {} }), resolved)).rejects.toBeInstanceOf(
      QueueConfigurationError,
    );
  });

  test('REQ-Q-1: the body source is the fingerprint, so it survives a re-published message', async () => {
    const resolved = resolveOptions({ ...base, key: 'body' });
    const first = fakeMessage({ id: 'id-1', body: { a: 1 } });
    const second = fakeMessage({ id: 'id-2', body: { a: 1 } });
    const key = await resolveKey(first, resolved);
    expect(key).toBe(await messageFingerprint({ a: 1 }));
    expect(await resolveKey(second, resolved)).toBe(key);
  });

  test('REQ-Q-1: a custom key function wins and its result is validated', async () => {
    const resolved = resolveOptions({ ...base, key: (m) => `order-${String(m.id)}` });
    await expect(resolveKey(fakeMessage({ id: '7', body: {} }), resolved)).resolves.toBe('order-7');
    const tooLong = resolveOptions({ ...base, key: () => 'x'.repeat(256) });
    await expect(resolveKey(fakeMessage({ body: {} }), tooLong)).rejects.toBeInstanceOf(
      QueueConfigurationError,
    );
  });
});

describe('scope resolution', () => {
  test('REQ-Q-1: redis-streams derives queue and consumer group from the metadata', () => {
    const message = fakeMessage({
      body: {},
      metadata: {
        provider: 'redis-streams',
        redisStreams: {
          stream: 'orders',
          entryId: '1-0',
          consumerGroup: 'workers',
          consumer: 'c1',
        },
      },
    });
    expect(resolveScope(message, resolveOptions(base))).toBe('orders/workers');
  });

  test('REQ-Q-1: an adapter without a group uses the queue name, and consumerGroup appends to it', () => {
    const message = fakeMessage({
      body: {},
      metadata: {
        provider: 'kafka',
        kafka: { topic: 'orders', partition: 0, offset: '9', highWatermark: '10' },
      },
    });
    expect(resolveScope(message, resolveOptions(base))).toBe('orders');
    expect(resolveScope(message, resolveOptions({ ...base, consumerGroup: 'billing' }))).toBe(
      'orders/billing',
    );
  });

  test('REQ-Q-1: an adapter that names no queue on the message demands an explicit scope', () => {
    const message = fakeMessage({
      body: {},
      metadata: {
        provider: 'rabbitmq',
        rabbitmq: {
          exchange: 'x',
          routingKey: 'r',
          consumerTag: 't',
          deliveryTag: 1,
          redelivered: false,
        },
      },
    });
    expect(() => resolveScope(message, resolveOptions(base))).toThrow(QueueConfigurationError);
    expect(resolveScope(message, resolveOptions({ ...base, scope: 'orders/workers' }))).toBe(
      'orders/workers',
    );
    expect(
      resolveScope(message, resolveOptions({ ...base, scope: (m) => `q/${m.metadata.provider}` })),
    ).toBe('q/rabbitmq');
  });
});
