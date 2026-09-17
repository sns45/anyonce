import { describe, expect, test } from 'bun:test';
import { idempotencyOf, withIdempotency } from '../../src/http';
import { MemoryStore } from '../../src/memory';
import type { Store } from '../../src/types';

const enc = new TextEncoder();

function post(path: string, key?: string, body = 'b', extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'text/plain', ...extra };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return new Request(`http://t.invalid${path}`, { method: 'POST', body, headers });
}

function counting(status = 201, headers: Record<string, string> = {}) {
  const state = { calls: 0, bodies: [] as string[] };
  const handler = async (req: Request): Promise<Response> => {
    state.calls += 1;
    state.bodies.push(await req.text());
    return new Response(`r${state.calls}`, {
      status,
      headers: { 'Content-Type': 'text/plain', ...headers },
    });
  };
  return { state, handler };
}

function failingStore(error = new Error('store down')): Store {
  const never = async () => {
    throw error;
  };
  return { begin: never, complete: never, abandon: never, get: never, purge: never };
}

describe('withIdempotency', () => {
  test('REQ-HTTP-1: a GET passes through untouched and a PATCH is covered by default', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    const get = new Request('http://t.invalid/p', { headers: { 'Idempotency-Key': 'k' } });
    await wrapped(get);
    await wrapped(get);
    expect(state.calls).toBe(2);
    const patch = new Request('http://t.invalid/p', {
      method: 'PATCH',
      body: 'b',
      headers: { 'Idempotency-Key': 'k' },
    });
    await wrapped(patch);
    await wrapped(patch.clone());
    expect(state.calls).toBe(3);
  });

  test('REQ-HTTP-1: a lowercase patch method is not matched, methods are case sensitive on the wire', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    // RFC 9110 method names are case sensitive and the Fetch spec normalizes only the six methods it lists,
    // so a lowercase patch reaches the layer as it was sent and must pass through untouched, as it does in
    // Go. Bun's Request constructor uppercases every method name, so the wire form is set on the instance.
    const lower = (): Request => {
      const req = new Request('http://t.invalid/p', {
        method: 'PATCH',
        headers: { 'Idempotency-Key': 'k' },
      });
      Object.defineProperty(req, 'method', { value: 'patch', configurable: true });
      return req;
    };
    expect(lower().method).toBe('patch');
    await wrapped(lower());
    await wrapped(lower());
    expect(state.calls).toBe(2);
  });

  test('REQ-HTTP-1: methods overrides the default list', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), methods: ['PUT'] });
    await wrapped(post('/p', 'k'));
    await wrapped(post('/p', 'k'));
    expect(state.calls).toBe(2);
    const put = () =>
      new Request('http://t.invalid/p', {
        method: 'PUT',
        body: 'b',
        headers: { 'Idempotency-Key': 'k' },
      });
    await wrapped(put());
    await wrapped(put());
    expect(state.calls).toBe(3);
  });

  test('REQ-HTTP-2: the header is found case-insensitively and a repeated header is 400 invalid-key', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    // The capture pump is pull driven, so the record settles once the client has read the streamed body.
    await (await wrapped(post('/p', undefined, 'b', { 'idempotency-key': 'k' }))).text();
    const replay = await wrapped(post('/p', 'k'));
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(state.calls).toBe(1);
    const headers = new Headers({ 'Content-Type': 'text/plain' });
    headers.append('Idempotency-Key', 'one');
    headers.append('Idempotency-Key', 'two');
    const res = await wrapped(
      new Request('http://t.invalid/p', { method: 'POST', body: 'b', headers }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid-key');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-2: an invalid escape in a quoted key yields 400 invalid-key whose detail carries no key characters', async () => {
    const { handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    const res = await wrapped(post('/p', '"a\\qb"'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid-key');
    // NFR-2/D7: the reason must never embed the offending character from the header
    // value itself (the pre-fix message was `invalid escape \q`, leaking key content).
    expect(body.detail).not.toContain('\\q');
    expect(body.detail).not.toContain('qb');
  });

  test('REQ-HTTP-3: a missing key passes through by default and is 400 missing-key with a Link when required', async () => {
    const { state, handler } = counting();
    const lenient = withIdempotency(handler, { store: new MemoryStore() });
    expect((await lenient(post('/p'))).status).toBe(201);
    expect(state.calls).toBe(1);
    const strict = withIdempotency(handler, {
      store: new MemoryStore(),
      required: true,
      docsUrl: 'https://d.test/keys',
    });
    const res = await strict(post('/p'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    expect(res.headers.get('Link')).toBe('<https://d.test/keys>; rel="describedby"');
    expect(await res.json()).toEqual({
      type: 'https://in8.sh/anyonce/problems/missing-key',
      title: 'The Idempotency-Key header is required for this request',
      status: 400,
      code: 'missing-key',
    });
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-4: strict syntax rejects a bare token with 400 invalid-key', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), keySyntax: 'strict' });
    expect((await wrapped(post('/p', 'bare'))).status).toBe(400);
    expect((await wrapped(post('/p', '"quoted"'))).status).toBe(201);
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-5: the default scope is method and pathname so the same key on another path executes again', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    await wrapped(post('/a?x=1', 'k'));
    await wrapped(post('/a?x=2', 'k'));
    expect(state.calls).toBe(1);
    await wrapped(post('/b', 'k'));
    expect(state.calls).toBe(2);
  });

  test('REQ-HTTP-5: principals isolate keys and a required principal that is missing is 500 missing-principal', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, {
      store: new MemoryStore(),
      principal: (req) => req.headers.get('x-tenant') ?? undefined,
      requirePrincipal: true,
    });
    await wrapped(post('/p', 'k', 'b', { 'x-tenant': 'a' }));
    await wrapped(post('/p', 'k', 'b', { 'x-tenant': 'b' }));
    expect(state.calls).toBe(2);
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('missing-principal');
    expect(state.calls).toBe(2);
  });

  test('REQ-HTTP-6: the handler still reads the body, and a body over maxRequestBytes is 413', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), maxRequestBytes: 4 });
    await wrapped(post('/p', 'k', 'abcd'));
    expect(state.bodies).toEqual(['abcd']);
    const res = await wrapped(post('/p', 'k2', 'abcde'));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('payload-too-large');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-6: jcs fingerprinting treats reordered JSON as the same payload', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), fingerprint: 'jcs' });
    await (await wrapped(post('/p', 'k', '{"a":1,"b":2}'))).text();
    const res = await wrapped(post('/p', 'k', '{"b":2,"a":1}'));
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-6: a custom fingerprint function decides what counts as the same request', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, {
      store: new MemoryStore(),
      fingerprint: async () => 'constant',
    });
    await wrapped(post('/p', 'k', 'one'));
    await wrapped(post('/p', 'k', 'two'));
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-7: the first request runs the handler and stores the captured response', async () => {
    const store = new MemoryStore();
    const { handler } = counting(201, { ETag: '"v1"', 'X-Other': 'no' });
    const wrapped = withIdempotency(handler, { store });
    const res = await wrapped(post('/p', 'k'));
    expect(await res.text()).toBe('r1');
    const record = await store.get({ scope: 'POST /p', key: 'k' }, Date.now());
    expect(record?.state).toBe('completed');
    expect(record?.result).toEqual({
      kind: 'http',
      status: 201,
      headers: [
        ['content-type', 'text/plain'],
        ['etag', '"v1"'],
      ],
      body: enc.encode('r1'),
    });
  });

  test('REQ-HTTP-8: Set-Cookie is never stored even when allowlisted', async () => {
    const store = new MemoryStore();
    const { handler } = counting(201, { 'Set-Cookie': 'a=1', 'X-Trace': 't' });
    const wrapped = withIdempotency(handler, { store, storeHeaders: ['Set-Cookie', 'X-Trace'] });
    await (await wrapped(post('/p', 'k'))).text();
    const record = await store.get({ scope: 'POST /p', key: 'k' }, Date.now());
    expect(record?.result?.headers).toEqual([['x-trace', 't']]);
  });

  test('REQ-HTTP-9: a completed duplicate replays status, headers and body with Idempotency-Replayed', async () => {
    const { state, handler } = counting(202, { Location: '/orders/1' });
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    await (await wrapped(post('/p', 'k'))).text();
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(202);
    expect(res.headers.get('Location')).toBe('/orders/1');
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await res.text()).toBe('r1');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-9: a result over maxResultBytes replays with an empty body and Idempotency-Replay omitted', async () => {
    const { handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), maxResultBytes: 1 });
    expect(await (await wrapped(post('/p', 'k'))).text()).toBe('r1');
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replay')).toBe('omitted');
    expect(await res.text()).toBe('');
  });

  test('REQ-HTTP-10: an in-flight duplicate is 409 conflict with Retry-After from the lease', async () => {
    let now = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handler = async () => {
      await gate;
      return new Response('done');
    };
    let acquired!: () => void;
    const claimed = new Promise<void>((r) => {
      acquired = r;
    });
    const wrapped = withIdempotency(handler, {
      store: new MemoryStore(),
      leaseMs: 30_000,
      clock: () => now,
      hooks: { onAcquired: () => acquired() },
    });
    const first = wrapped(post('/p', 'k'));
    await claimed;
    now += 4_500;
    const dup = await wrapped(post('/p', 'k'));
    expect(dup.status).toBe(409);
    expect(dup.headers.get('Retry-After')).toBe('26');
    expect((await dup.json()).code).toBe('conflict');
    release();
    expect(await (await first).text()).toBe('done');
  });

  test('REQ-HTTP-10: Retry-After is at least 1', async () => {
    let now = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let acquired!: () => void;
    const claimed = new Promise<void>((r) => {
      acquired = r;
    });
    const wrapped = withIdempotency(
      async () => {
        await gate;
        return new Response('done');
      },
      {
        store: new MemoryStore(),
        leaseMs: 30_000,
        clock: () => now,
        hooks: { onAcquired: () => acquired() },
      },
    );
    const first = wrapped(post('/p', 'k'));
    await claimed;
    now += 29_999;
    expect((await wrapped(post('/p', 'k'))).headers.get('Retry-After')).toBe('1');
    release();
    await first;
  });

  test('REQ-HTTP-11: the same key with a different body is 422 fingerprint-mismatch and the original still replays', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    await (await wrapped(post('/p', 'k', 'one'))).text();
    const res = await wrapped(post('/p', 'k', 'two'));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('fingerprint-mismatch');
    expect((await wrapped(post('/p', 'k', 'one'))).headers.get('Idempotency-Replayed')).toBe(
      'true',
    );
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-12: a failing store is 503 store-unavailable with Retry-After 1 when fail-closed', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: failingStore() });
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect((await res.json()).code).toBe('store-unavailable');
    expect(state.calls).toBe(0);
  });

  test('REQ-HTTP-12: fail-open runs the handler and marks the response Idempotency-Degraded', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: failingStore(), onStoreError: 'fail-open' });
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Degraded')).toBe('true');
    expect(await res.text()).toBe('r1');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-13: onError renders every problem and problems use the configured base URI', async () => {
    const wrapped = withIdempotency(counting().handler, {
      store: new MemoryStore(),
      required: true,
      problemBaseUri: 'https://p.test/',
      onError: (problem) =>
        new Response(`custom:${problem.code}:${problem.type}`, { status: problem.status }),
    });
    const res = await wrapped(post('/p'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Link')).toBe('<https://p.test/missing-key>; rel="describedby"');
    expect(await res.text()).toBe('custom:missing-key:https://p.test/missing-key');
  });

  test('REQ-HTTP-13: an onError response keeps Retry-After and Cache-Control unless it sets them itself', async () => {
    let now = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handler = async () => {
      await gate;
      return new Response('done');
    };
    let acquired!: () => void;
    const claimed = new Promise<void>((r) => {
      acquired = r;
    });
    const wrapped = withIdempotency(handler, {
      store: new MemoryStore(),
      leaseMs: 30_000,
      clock: () => now,
      hooks: { onAcquired: () => acquired() },
      onError: (problem) => new Response(`custom:${problem.code}`, { status: problem.status }),
    });
    const first = wrapped(post('/p', 'k'));
    await claimed;
    now += 4_500;
    const dup = await wrapped(post('/p', 'k'));
    expect(dup.status).toBe(409);
    expect(dup.headers.get('Retry-After')).toBe('26');
    expect(dup.headers.get('Cache-Control')).toBe('no-store');
    expect(await dup.text()).toBe('custom:conflict');
    release();
    await first;

    let now2 = 1_000_000;
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => {
      release2 = r;
    });
    const handler2 = async () => {
      await gate2;
      return new Response('done');
    };
    let acquired2!: () => void;
    const claimed2 = new Promise<void>((r) => {
      acquired2 = r;
    });
    const wrapped2 = withIdempotency(handler2, {
      store: new MemoryStore(),
      leaseMs: 30_000,
      clock: () => now2,
      hooks: { onAcquired: () => acquired2() },
      onError: (problem) =>
        new Response(`custom:${problem.code}`, {
          status: problem.status,
          headers: { 'Cache-Control': 'private, max-age=5' },
        }),
    });
    const first2 = wrapped2(post('/p', 'k'));
    await claimed2;
    now2 += 4_500;
    const dup2 = await wrapped2(post('/p', 'k'));
    expect(dup2.status).toBe(409);
    expect(dup2.headers.get('Retry-After')).toBe('26');
    expect(dup2.headers.get('Cache-Control')).toBe('private, max-age=5');
    release2();
    await first2;
  });

  test('REQ-HTTP-13: an onError response whose body was already read is returned untouched', async () => {
    const wrapped = withIdempotency(counting().handler, {
      store: new MemoryStore(),
      required: true,
      onError: async (problem) => {
        const res = new Response(`custom:${problem.code}`, { status: problem.status });
        await res.text();
        return res;
      },
    });
    const res = await wrapped(post('/p'));
    expect(res.status).toBe(400);
  });

  test('REQ-HTTP-14: the handler reads the key and fence through idempotencyOf', async () => {
    const seen: Array<{ key: string; fence: number } | undefined> = [];
    const wrapped = withIdempotency(
      async (req: Request) => {
        seen.push(idempotencyOf(req));
        return new Response('ok');
      },
      { store: new MemoryStore() },
    );
    await (await wrapped(post('/p', 'k'))).text();
    await (await wrapped(new Request('http://t.invalid/p'))).text();
    expect(seen).toEqual([{ key: 'k', fence: 1 }, undefined]);
  });

  test('REQ-HTTP-15: skip opts a request out entirely', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, {
      store: new MemoryStore(),
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    await wrapped(post('/reset', 'k'));
    await wrapped(post('/reset', 'k'));
    expect(state.calls).toBe(2);
  });

  test('REQ-HTTP-17: extra handler arguments pass through and a thrown handler error propagates after abandon', async () => {
    const store = new MemoryStore();
    const seen: unknown[] = [];
    const wrapped = withIdempotency(
      async (_req: Request, env: { name: string }, ctx: number) => {
        seen.push(env.name, ctx);
        throw new Error('handler failed');
      },
      { store },
    );
    await expect(wrapped(post('/p', 'k'), { name: 'env' }, 7)).rejects.toThrow('handler failed');
    expect(seen).toEqual(['env', 7]);
    expect(await store.get({ scope: 'POST /p', key: 'k' }, Date.now())).toBeNull();
  });

  test('REQ-HTTP-7: a 5xx response is not stored (D6) so the retry executes again', async () => {
    const { state, handler } = counting(500);
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    expect(await (await wrapped(post('/p', 'k'))).text()).toBe('r1');
    const retry = await wrapped(post('/p', 'k'));
    expect(retry.headers.get('Idempotency-Replayed')).toBeNull();
    expect(await retry.text()).toBe('r2');
    expect(state.calls).toBe(2);
  });
});
