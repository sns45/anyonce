import { describe, expect, test } from 'bun:test';
import type { Operation, Store } from '@anyonce/core';
import { MemoryStore } from '@anyonce/core';
import type { Problem } from '@anyonce/core/http';
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
    const body = (await res.json()) as {
      code: string;
      status: number;
      title: string;
      detail: string;
    };
    expect(body.code).toBe('configuration-error');
    expect(body.status).toBe(500);
    expect(body.title).toBe(
      'The webhook endpoint could not establish that this delivery is genuine',
    );
    expect(body.detail).toBe('no verify callback or verifiedMarker is configured');
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

  test('REQ-WH-2: a verify callback that throws is 500 configuration-error and never calls begin', async () => {
    const { store, begins } = countingStore();
    const messages: string[] = [];
    const handler = webhookReceiver({
      store,
      logger: (m) => messages.push(m),
      verify: () => {
        throw new Error('verifier exploded on key msg_1');
      },
    })(async () => new Response('handled'));
    const res = await handler(delivery());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe('configuration-error');
    expect(body.detail).toBe('the verify callback failed');
    expect(begins).toEqual([]);
    // Ruling 12: the malfunction is not silent, and the line carries neither the thrown error nor the id.
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain('msg_1');
    expect(messages[0]).not.toContain('exploded');
  });

  test('REQ-WH-2: the two configuration-error causes log independently and carry different details', async () => {
    const run = async (
      options: Parameters<typeof webhookReceiver>[0],
    ): Promise<{ detail: string; messages: string[] }> => {
      const messages: string[] = [];
      const handler = webhookReceiver({ ...options, logger: (m) => messages.push(m) })(
        async () => new Response('handled'),
      );
      let detail = '';
      for (let i = 0; i < 3; i += 1) {
        const res = await handler(delivery());
        expect(res.status).toBe(500);
        detail = ((await res.json()) as { detail: string }).detail;
      }
      return { detail, messages };
    };

    const unconfigured = await run({ store: countingStore().store });
    const failed = await run({
      store: countingStore().store,
      verify: () => {
        throw new Error('down');
      },
    });
    expect(unconfigured.detail).not.toBe(failed.detail);
    // Each cause has its own latch, so neither suppresses the other, and each still logs exactly once.
    expect(unconfigured.messages).toHaveLength(1);
    expect(failed.messages).toHaveLength(1);
    expect(unconfigured.messages[0]).not.toBe(failed.messages[0]);
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

  test('REQ-WH-2: a GET to a receiver with no verification still gets 500 configuration-error', async () => {
    const { store, begins } = countingStore();
    // The logger is injected purely so the one configuration line does not reach stderr and muddy the run.
    const handler = webhookReceiver({ store, logger: () => {} })(
      async () => new Response('handled'),
    );
    const res = await handler(new Request('https://example.test/hooks/stripe', { method: 'GET' }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe('configuration-error');
    expect(begins).toEqual([]);
  });

  test('REQ-WH-2: a custom onError still carries Cache-Control no-store on every gate problem', async () => {
    // Ruling 21: the receiver renders the gate's problems itself, so without the protocol header merge a
    // custom renderer produced cacheable 401, 500 and 413 responses while the bridge's own problems on the
    // same receiver were no-store. The renderer sets neither header, which is the whole point.
    const onError = (p: Problem): Response =>
      new Response(`custom:${p.code}`, { status: p.status });
    const unconfigured = webhookReceiver({
      store: countingStore().store,
      logger: () => {},
      onError,
    })(async () => new Response('handled'));
    const invalid = webhookReceiver({ store: countingStore().store, verify: () => false, onError })(
      async () => new Response('handled'),
    );
    const tooLarge = webhookReceiver({
      store: countingStore().store,
      verify: () => true,
      maxRequestBytes: 8,
      onError,
    })(async () => new Response('handled'));

    for (const [status, res] of [
      [500, await unconfigured(delivery())],
      [401, await invalid(delivery())],
      [413, await tooLarge(delivery('x'.repeat(64)))],
    ] as const) {
      expect(res.status).toBe(status);
      expect(await res.text()).toStartWith('custom:');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      // Ruling 20: the 401's challenge survives a custom renderer the same way.
      expect(res.headers.get('WWW-Authenticate')).toBe(status === 401 ? 'Signature' : null);
    }
  });

  test('REQ-WH-2: a 401 carries the RFC 9110 WWW-Authenticate challenge and no other problem does', async () => {
    // Ruling 20: RFC 9110 section 15.5.2 makes at least one challenge a MUST on a 401, and signature-invalid
    // is the only problem this door answers with one.
    const invalid = webhookReceiver({ store: countingStore().store, verify: () => false })(
      async () => new Response('handled'),
    );
    const unauthorized = await invalid(delivery());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('WWW-Authenticate')).toBe('Signature');

    const unconfigured = webhookReceiver({ store: countingStore().store, logger: () => {} })(
      async () => new Response('handled'),
    );
    const tooLarge = webhookReceiver({
      store: countingStore().store,
      verify: () => true,
      maxRequestBytes: 8,
    })(async () => new Response('handled'));
    const missingId = webhookReceiver({ store: countingStore().store, verify: () => true })(
      async () => new Response('handled'),
    );
    for (const [status, res] of [
      [500, await unconfigured(delivery())],
      [413, await tooLarge(delivery('x'.repeat(64)))],
      [400, await missingId(delivery('{"a":1}', {}))],
    ] as const) {
      expect(res.status).toBe(status);
      expect(res.headers.get('WWW-Authenticate')).toBeNull();
    }
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
