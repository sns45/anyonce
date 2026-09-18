import { describe, expect, test } from 'bun:test';
import type { IdempotencyRecord } from '@anyonce/core';
import { MemoryStore } from '@anyonce/core';
import { webhookReceiver } from '../src/index';

const store = (): MemoryStore => new MemoryStore();

function delivery(
  id: string | undefined,
  body: string,
  path = '/hooks/stripe',
  extra: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (id !== undefined) headers['webhook-id'] = id;
  return new Request(`https://example.test${path}`, { method: 'POST', headers, body });
}

describe('webhook receiver', () => {
  test('REQ-WH-1: the delivery id comes from the webhook-id header and becomes the store key', async () => {
    const s = store();
    let runs = 0;
    const handler = webhookReceiver({ store: s, verify: () => true })(async () => {
      runs += 1;
      return new Response('handled', { status: 200 });
    });
    const res = await handler(delivery('msg_2ab', '{"a":1}'));
    expect(res.status).toBe(200);
    expect(runs).toBe(1);
    // P2 response capture is pull driven: the record only completes once the client drains the body.
    await res.text();
    const record = await s.get({ scope: '/hooks/stripe', key: 'msg_2ab' }, Date.now());
    expect(record?.state).toBe('completed');
  });

  test('REQ-WH-1: a key function reads the id out of the body and wins over the header', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      key: (_req, body) => (JSON.parse(new TextDecoder().decode(body)) as { id: string }).id,
    })(async () => new Response('handled'));
    await handler(delivery('msg_header', '{"id":"evt_body"}'));
    expect(await s.get({ scope: '/hooks/stripe', key: 'evt_body' }, Date.now())).not.toBeNull();
    expect(await s.get({ scope: '/hooks/stripe', key: 'msg_header' }, Date.now())).toBeNull();
  });

  test('REQ-WH-1: a verified delivery with no id is 400 missing-key', async () => {
    const handler = webhookReceiver({ store: store(), verify: () => true })(
      async () => new Response('never'),
    );
    const res = await handler(delivery(undefined, '{"a":1}'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; title: string };
    expect(body.code).toBe('missing-key');
    expect(body.title).toBe('The webhook-id header is required for this request');
  });

  test('REQ-WH-1: an id longer than 255 bytes is 400 invalid-key', async () => {
    const handler = webhookReceiver({ store: store(), verify: () => true })(
      async () => new Response('never'),
    );
    const res = await handler(delivery('m'.repeat(256), '{"a":1}'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid-key');
  });

  test('REQ-WH-1: an empty webhook-id header is treated as missing, the same as no header at all', async () => {
    const handler = webhookReceiver({ store: store(), verify: () => true })(
      async () => new Response('never'),
    );
    const res = await handler(delivery('', '{"a":1}'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('missing-key');
  });

  test('REQ-WH-1: the scope is the route pattern alone when no sourceId is configured', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      routePattern: '/hooks/:provider',
    })(async () => new Response('handled'));
    await handler(delivery('msg_scope', '{"a":1}'));
    expect(await s.get({ scope: '/hooks/:provider', key: 'msg_scope' }, Date.now())).not.toBeNull();
  });

  test('REQ-WH-1: a sourceId is appended to the route pattern after a slash', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      routePattern: '/hooks/:provider',
      sourceId: () => 'acct_42',
    })(async () => new Response('handled'));
    await handler(delivery('msg_scope', '{"a":1}'));
    expect(
      await s.get({ scope: '/hooks/:provider/acct_42', key: 'msg_scope' }, Date.now()),
    ).not.toBeNull();
  });

  test('REQ-WH-1: a sourceId function that returns nothing falls back to the route alone', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      routePattern: '/hooks/:provider',
      sourceId: () => undefined,
    })(async () => new Response('handled'));
    await handler(delivery('msg_scope', '{"a":1}'));
    expect(await s.get({ scope: '/hooks/:provider', key: 'msg_scope' }, Date.now())).not.toBeNull();
  });

  test('REQ-WH-1: a sourceId function that returns an empty string falls back to the route alone', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      routePattern: '/hooks/:provider',
      sourceId: () => '',
    })(async () => new Response('handled'));
    await handler(delivery('msg_scope', '{"a":1}'));
    expect(await s.get({ scope: '/hooks/:provider', key: 'msg_scope' }, Date.now())).not.toBeNull();
  });

  test('REQ-WH-1: a routePattern function computes the route from the request', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      routePattern: (req) => `/dynamic${new URL(req.url).pathname}`,
    })(async () => new Response('handled'));
    await handler(delivery('msg_scope', '{"a":1}', '/hooks/github'));
    expect(
      await s.get({ scope: '/dynamic/hooks/github', key: 'msg_scope' }, Date.now()),
    ).not.toBeNull();
  });

  test('REQ-WH-1: a scope function replaces the computed scope, so routePattern is never consulted', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      routePattern: '/hooks/:provider',
      scope: () => 'tenant_7',
    })(async () => new Response('handled'));
    await handler(delivery('msg_scope', '{"a":1}'));
    expect(await s.get({ scope: 'tenant_7', key: 'msg_scope' }, Date.now())).not.toBeNull();
    expect(await s.get({ scope: '/hooks/:provider', key: 'msg_scope' }, Date.now())).toBeNull();
  });

  test('REQ-WH-1: a scope function sees the request and the body bytes', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      scope: (req, body) =>
        `${new URL(req.url).pathname}/${(JSON.parse(new TextDecoder().decode(body)) as { account: string }).account}`,
    })(async () => new Response('handled'));
    await handler(delivery('msg_scope', '{"account":"acct_9"}'));
    expect(
      await s.get({ scope: '/hooks/stripe/acct_9', key: 'msg_scope' }, Date.now()),
    ).not.toBeNull();
  });

  test('REQ-WH-1: scope together with sourceId is a TypeError at construction', () => {
    expect(() =>
      webhookReceiver({
        store: store(),
        verify: () => true,
        scope: () => 'tenant_7',
        sourceId: () => 'acct_42',
      }),
    ).toThrow(TypeError);
  });

  test('REQ-WH-1: the same id in two source scopes runs the handler twice', async () => {
    const s = store();
    let runs = 0;
    const make = (source: string) =>
      webhookReceiver({ store: s, verify: () => true, sourceId: () => source })(async () => {
        runs += 1;
        return new Response('handled');
      });
    await make('acct_1')(delivery('msg_shared', '{"a":1}'));
    await make('acct_2')(delivery('msg_shared', '{"a":1}'));
    expect(runs).toBe(2);
  });

  test('REQ-WH-1: the fingerprint is SHA-256 over the body bytes alone, so the same body on two paths matches', async () => {
    const s = store();
    const handler = webhookReceiver({ store: s, verify: () => true, routePattern: '/hooks' })(
      async () => new Response('handled'),
    );
    const firstRes = await handler(delivery('msg_fp', '{"a":1}', '/hooks/one'));
    // Drain before the record is checked: completion is pull driven, and the second delivery must see it
    // completed rather than in flight.
    await firstRes.text();
    const first = await s.get({ scope: '/hooks', key: 'msg_fp' }, Date.now());
    const second = await handler(delivery('msg_fp', '{"a":1}', '/hooks/two'));
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(first?.fingerprint).toBe(
      (await s.get({ scope: '/hooks', key: 'msg_fp' }, Date.now()))?.fingerprint,
    );
  });

  test('REQ-WH-3: a redelivery replays the stored response with Idempotency-Replayed true and runs the handler once', async () => {
    const s = store();
    let runs = 0;
    const handler = webhookReceiver({ store: s, verify: () => true })(async () => {
      runs += 1;
      return new Response('{"ok":true}', {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const first = await handler(delivery('msg_replay', '{"a":1}'));
    expect(first.status).toBe(202);
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();
    // Drain the first response before redelivering: completion is pull driven.
    await first.text();
    const second = await handler(delivery('msg_replay', '{"a":1}'));
    expect(second.status).toBe(202);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await second.text()).toBe('{"ok":true}');
    expect(runs).toBe(1);
  });

  test('REQ-WH-3: a stored 4xx replays as the stored 4xx, because D6 stores every status below 500', async () => {
    const s = store();
    let runs = 0;
    const handler = webhookReceiver({ store: s, verify: () => true })(async () => {
      runs += 1;
      return new Response('rejected', { status: 422 });
    });
    const first = await handler(delivery('msg_4xx', '{"a":1}'));
    // Drain before redelivering: completion is pull driven.
    await first.text();
    const second = await handler(delivery('msg_4xx', '{"a":1}'));
    expect(second.status).toBe(422);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(runs).toBe(1);
  });

  test('REQ-WH-4: a redelivery while the first is in flight is 409 with Retry-After at least 1', async () => {
    const s = store();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = webhookReceiver({ store: s, verify: () => true, leaseMs: 30_000 })(async () => {
      await gate;
      return new Response('handled');
    });
    const first = handler(delivery('msg_inflight', '{"a":1}'));
    const second = await handler(delivery('msg_inflight', '{"a":1}'));
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string; title: string };
    expect(body.code).toBe('conflict');
    expect(body.title).toBe('A delivery with this webhook-id is still in progress');
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    release();
    expect((await first).status).toBe(200);
  });

  test('REQ-WH-5: the same id with a different body is 422 and fires onSuspicious with the stored record', async () => {
    const s = store();
    const suspicious: Array<{ path: string; record: IdempotencyRecord }> = [];
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      onSuspicious: (req, record) => {
        suspicious.push({ path: new URL(req.url).pathname, record });
      },
    })(async () => new Response('handled'));
    const first = await handler(delivery('msg_mismatch', '{"amount":10}'));
    // Drain before redelivering: completion is pull driven, and the stored record must be completed for the
    // second delivery to see a mismatch rather than a conflict.
    await first.text();
    const second = await handler(delivery('msg_mismatch', '{"amount":9000}'));
    expect(second.status).toBe(422);
    const body = (await second.json()) as { code: string; title: string };
    expect(body.code).toBe('fingerprint-mismatch');
    expect(body.title).toBe('This webhook-id was already delivered with a different payload');
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]?.path).toBe('/hooks/stripe');
    expect(suspicious[0]?.record.key).toBe('msg_mismatch');
    expect(suspicious[0]?.record.state).toBe('completed');
  });

  test('REQ-WH-5: an onSuspicious hook that throws does not change the 422', async () => {
    const s = store();
    let calls = 0;
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      onSuspicious: () => {
        calls += 1;
        throw new Error('hook exploded');
      },
    })(async () => new Response('handled'));
    const first = await handler(delivery('msg_throwing', '{"a":1}'));
    // Drain before redelivering: completion is pull driven.
    await first.text();
    const second = await handler(delivery('msg_throwing', '{"a":2}'));
    expect(second.status).toBe(422);
    expect(calls).toBe(1);
  });

  test('REQ-WH-5: a throwing user onMismatch hook still fires onSuspicious', async () => {
    const s = store();
    const suspicious: string[] = [];
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      hooks: {
        onMismatch: () => {
          throw new Error('onMismatch exploded');
        },
      },
      onSuspicious: (_req, record) => {
        suspicious.push(record.key);
      },
    })(async () => new Response('handled'));
    const first = await handler(delivery('msg_both_hooks', '{"a":1}'));
    await first.text();
    const second = await handler(delivery('msg_both_hooks', '{"a":2}'));
    expect(second.status).toBe(422);
    expect(suspicious).toEqual(['msg_both_hooks']);
  });

  test('REQ-WH-1: a GET passes through untouched because the receiver applies to POST only', async () => {
    const s = store();
    let runs = 0;
    let verifyRan = false;
    const handler = webhookReceiver({
      store: s,
      verify: () => {
        verifyRan = true;
        return true;
      },
    })(async () => {
      runs += 1;
      return new Response('handled');
    });
    const res = await handler(new Request('https://example.test/hooks/stripe', { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(runs).toBe(1);
    expect(res.headers.get('Idempotency-Replayed')).toBeNull();
    expect(verifyRan).toBe(false);
  });

  test('REQ-WH-1: the handler receives the body unread', async () => {
    const s = store();
    const seen: string[] = [];
    const handler = webhookReceiver({ store: s, verify: () => true })(async (req) => {
      seen.push(await req.text());
      return new Response('handled');
    });
    await handler(delivery('msg_body', '{"payload":"intact"}'));
    expect(seen).toEqual(['{"payload":"intact"}']);
  });
});
