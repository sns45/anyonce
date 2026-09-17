import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import { Hono } from 'hono';
import { hc } from 'hono/client';
import { type IdempotencyEnv, idempotency } from '../src';

const app = new Hono<IdempotencyEnv>()
  .use(idempotency({ store: new MemoryStore() }))
  .post('/typed', (c) => {
    const key: string | undefined = c.get('idempotencyKey');
    const fence: number | undefined = c.get('idempotencyFence');
    return c.json({ key: key ?? null, fence: fence ?? null });
  });

type AppType = typeof app;

describe('typing', () => {
  test('REQ-HTTP-16: hc<AppType> sees the route and the variables are typed on the env', async () => {
    const client = hc<AppType>('http://t.invalid', {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init),
    });
    const res = await client.typed.$post({}, { headers: { 'Idempotency-Key': 'k' } });
    expect(await res.json()).toEqual({ key: 'k', fence: 1 });
  });
});
