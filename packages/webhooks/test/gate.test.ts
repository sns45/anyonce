import { describe, expect, test } from 'bun:test';
import type { Operation, Store } from '@anyonce/core';
import { MemoryStore } from '@anyonce/core';
import { markVerified, webhookReceiver } from '../src/index';

function countingStore(): { store: Store; begins: Operation[] } {
  const inner = new MemoryStore();
  const begins: Operation[] = [];
  const store: Store = {
    begin(op, opts) {
      begins.push(op);
      return inner.begin(op, opts);
    },
    complete: (op, fence, result, now) => inner.complete(op, fence, result, now),
    abandon: (op, fence) => inner.abandon(op, fence),
    get: (op, now) => inner.get(op, now),
    purge: (now) => inner.purge(now),
  };
  return { store, begins };
}

function delivery(
  body = '{"a":1}',
  headers: Record<string, string> = { 'webhook-id': 'msg_1' },
): Request {
  return new Request('https://example.test/hooks/stripe', { method: 'POST', headers, body });
}

describe('verification gate', () => {
  test('REQ-WH-2: a receiver with neither verify nor verifiedMarker answers 500 configuration-error and never calls begin', async () => {
    const { store, begins } = countingStore();
    const messages: string[] = [];
    const handler = webhookReceiver({ store, logger: (m) => messages.push(m) })(
      async () => new Response('handled'),
    );
    const res = await handler(delivery());
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe('configuration-error');
    expect(body.status).toBe(500);
    expect(begins).toEqual([]);
    expect(messages).toHaveLength(1);
  });

  test('REQ-WH-2: the configuration error logs once however many requests arrive', async () => {
    const { store } = countingStore();
    const messages: string[] = [];
    const handler = webhookReceiver({ store, logger: (m) => messages.push(m) })(
      async () => new Response('handled'),
    );
    await handler(delivery());
    await handler(delivery());
    await handler(delivery());
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain('msg_1');
  });

  test('REQ-WH-2: a verify callback that returns false answers 401 signature-invalid and never calls begin', async () => {
    const { store, begins } = countingStore();
    const handler = webhookReceiver({ store, verify: () => false })(
      async () => new Response('handled'),
    );
    const res = await handler(delivery());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('signature-invalid');
    expect(begins).toEqual([]);
  });

  test('REQ-WH-2: verify sees the raw body bytes and the request', async () => {
    const { store } = countingStore();
    const seen: string[] = [];
    const handler = webhookReceiver({
      store,
      verify: (req, body) => {
        seen.push(`${new URL(req.url).pathname}:${new TextDecoder().decode(body)}`);
        return false;
      },
    })(async () => new Response('handled'));
    await handler(delivery('{"b":2}'));
    expect(seen).toEqual(['/hooks/stripe:{"b":2}']);
  });

  test('REQ-WH-2: a verifiedMarker that was never set answers 401 and never calls begin', async () => {
    const { store, begins } = countingStore();
    const handler = webhookReceiver({ store, verifiedMarker: 'gateway' })(
      async () => new Response('handled'),
    );
    const res = await handler(delivery());
    expect(res.status).toBe(401);
    expect(begins).toEqual([]);
  });

  test('REQ-WH-2: a marker set by an upstream verifier passes the gate', async () => {
    const { store, begins } = countingStore();
    const handler = webhookReceiver({ store, verifiedMarker: 'gateway' })(
      async () => new Response('handled', { status: 202 }),
    );
    const req = delivery();
    markVerified(req, 'gateway');
    const res = await handler(req);
    expect(res.status).toBe(202);
    expect(begins).toHaveLength(1);
  });

  test('REQ-WH-2: an oversized body is 413 before verification and never calls begin', async () => {
    const { store, begins } = countingStore();
    const handler = webhookReceiver({ store, verify: () => false, maxRequestBytes: 8 })(
      async () => new Response('handled'),
    );
    const res = await handler(delivery('x'.repeat(64)));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe('payload-too-large');
    expect(begins).toEqual([]);
  });
});
