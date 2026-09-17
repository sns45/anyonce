import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import { Hono } from 'hono';
import { type IdempotencyEnv, idempotency } from '../src';

function post(path: string, key?: string, body = 'b'): Request {
  const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return new Request(`http://t.invalid${path}`, { method: 'POST', body, headers });
}

function build(store = new MemoryStore()) {
  const state = { calls: 0 };
  const app = new Hono<IdempotencyEnv>()
    .use(idempotency({ store, required: true }))
    .post('/orders/:id', async (c) => {
      state.calls += 1;
      const body = await c.req.text();
      return c.json(
        {
          id: c.req.param('id'),
          body,
          key: c.get('idempotencyKey'),
          fence: c.get('idempotencyFence'),
        },
        201,
      );
    })
    .get('/orders/:id', (c) => c.json({ key: c.get('idempotencyKey') ?? null }));
  return { app, state, store };
}

describe('idempotency middleware', () => {
  test('REQ-HTTP-16: the first request runs the handler and the duplicate replays it', async () => {
    const { app, state } = build();
    const first = await app.fetch(post('/orders/1', 'k'));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ id: '1', body: 'b', key: 'k', fence: 1 });
    const replay = await app.fetch(post('/orders/1', 'k'));
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(replay.headers.get('Content-Type')).toContain('application/json');
    expect(await replay.json()).toEqual({ id: '1', body: 'b', key: 'k', fence: 1 });
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-14: the handler reads idempotencyKey and idempotencyFence from the context and a GET sees neither', async () => {
    const { app } = build();
    expect(await (await app.fetch(post('/orders/2', 'k2'))).json()).toMatchObject({
      key: 'k2',
      fence: 1,
    });
    expect(await (await app.fetch(new Request('http://t.invalid/orders/2'))).json()).toEqual({
      key: null,
    });
  });

  test('REQ-HTTP-5: the default scope is the route pattern so two ids share a scope but a different route does not', async () => {
    const { app, state, store } = build();
    await (await app.fetch(post('/orders/1', 'k'))).text();
    await (await app.fetch(post('/orders/2', 'k'))).text();
    expect(state.calls).toBe(1);
    const record = await store.get({ scope: 'POST /orders/:id', key: 'k' }, Date.now());
    expect(record?.state).toBe('completed');
  });

  test('REQ-HTTP-5: an unmatched route scopes by request path so two unknown paths do not share a record', async () => {
    const { app, store } = build();
    const first = await app.fetch(post('/nope-a', 'k'));
    expect(first.status).toBe(404);
    await first.text();
    const second = await app.fetch(post('/nope-b', 'k'));
    expect(second.status).toBe(404);
    await second.text();
    const recordA = await store.get({ scope: 'POST /nope-a', key: 'k' }, Date.now());
    const recordB = await store.get({ scope: 'POST /nope-b', key: 'k' }, Date.now());
    expect(recordA?.state).toBe('completed');
    expect(recordB?.state).toBe('completed');
  });

  test('REQ-HTTP-3: a missing key is a problem response through the middleware', async () => {
    const { app, state } = build();
    const res = await app.fetch(post('/orders/1'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    expect((await res.json()).code).toBe('missing-key');
    expect(state.calls).toBe(0);
  });

  test('REQ-HTTP-16: a handler that throws reaches app.onError and the record is abandoned', async () => {
    const store = new MemoryStore();
    const app = new Hono<IdempotencyEnv>()
      .use(idempotency({ store }))
      .post('/boom', () => {
        throw new Error('boom');
      })
      .onError((err, c) => c.text(err.message, 500));
    const res = await app.fetch(post('/boom', 'k'));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('boom');
    expect(await store.get({ scope: 'POST /boom', key: 'k' }, Date.now())).toBeNull();
  });

  test('REQ-HTTP-7: a streamed Hono response reaches the client chunk by chunk', async () => {
    const { stream } = await import('hono/streaming');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = new Hono<IdempotencyEnv>()
      .use(idempotency({ store: new MemoryStore() }))
      .post('/s', (c) =>
        stream(c, async (s) => {
          await s.write('first');
          await gate;
          await s.write('second');
        }),
      );
    const res = await app.fetch(post('/s', 'k'));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('second');
    expect((await reader.read()).done).toBe(true);
  });
});
