import { describe, expect, test } from 'bun:test';
import { withIdempotency } from '../../src/http';
import { MemoryStore } from '../../src/memory';
import type { Store } from '../../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('streaming', () => {
  test('REQ-HTTP-7: the client receives the first chunk before the handler finishes and EOF only after the record is complete', async () => {
    const inner = new MemoryStore();
    let completed = false;
    const store: Store = {
      begin: (op, opts) => inner.begin(op, opts),
      complete: async (op, fence, result, now) => {
        const status = await inner.complete(op, fence, result, now);
        completed = true;
        return status;
      },
      abandon: (op, fence) => inner.abandon(op, fence),
      get: (op, now) => inner.get(op, now),
      purge: (now) => inner.purge(now),
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let handlerDone = false;
    const handler = withIdempotency(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(enc.encode('first'));
              await gate;
              c.enqueue(enc.encode('second'));
              c.close();
              handlerDone = true;
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/plain' } },
        ),
      { store },
    );
    const res = await handler(
      new Request('http://t.invalid/stream', {
        method: 'POST',
        body: 'b',
        headers: { 'Idempotency-Key': 'k1' },
      }),
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe('first');
    expect(handlerDone).toBe(false);
    expect((await store.get({ scope: 'POST /stream', key: 'k1' }, Date.now()))?.state).toBe(
      'in_flight',
    );
    release();
    const second = await reader.read();
    expect(dec.decode(second.value)).toBe('second');
    const end = await reader.read();
    expect(end.done).toBe(true);
    expect(completed).toBe(true);
    const record = await store.get({ scope: 'POST /stream', key: 'k1' }, Date.now());
    expect(record?.state).toBe('completed');
    expect(dec.decode(record?.result?.body)).toBe('firstsecond');
  });

  test('REQ-HTTP-7: a bodiless response is released only once the record is complete', async () => {
    const store = new MemoryStore();
    const handler = withIdempotency(async () => new Response(null, { status: 204 }), { store });
    const res = await handler(
      new Request('http://t.invalid/none', {
        method: 'POST',
        body: 'b',
        headers: { 'Idempotency-Key': 'k2' },
      }),
    );
    expect(res.status).toBe(204);
    expect((await store.get({ scope: 'POST /none', key: 'k2' }, Date.now()))?.state).toBe(
      'completed',
    );
  });
});
