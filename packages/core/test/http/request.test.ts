import { describe, expect, test } from 'bun:test';
import { httpFingerprint, jcsFingerprint, sha256Hex } from '../../src/fingerprint';
import { resolveHttpOptions } from '../../src/http/options';
import {
  defaultScope,
  lookupKey,
  readBody,
  requestFingerprint,
  requestPath,
  resolveScope,
} from '../../src/http/request';
import { MemoryStore } from '../../src/memory';

const store = new MemoryStore();
const enc = new TextEncoder();

function post(path: string, body?: string, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) init.body = body;
  return new Request(`http://t.invalid${path}`, init);
}

describe('lookupKey', () => {
  test('REQ-HTTP-2: the header name is matched case-insensitively', () => {
    const headers = new Headers({ 'idempotency-key': 'abc' });
    expect(lookupKey(headers, 'Idempotency-Key', 'lenient')).toEqual({ kind: 'ok', key: 'abc' });
    expect(lookupKey(new Headers(), 'Idempotency-Key', 'lenient')).toEqual({ kind: 'missing' });
  });

  test('REQ-HTTP-2: a repeated header field is invalid because the joined value is not a key', () => {
    const headers = new Headers();
    headers.append('Idempotency-Key', 'one');
    headers.append('Idempotency-Key', 'two');
    const result = lookupKey(headers, 'Idempotency-Key', 'lenient');
    expect(result.kind).toBe('invalid');
    const quoted = new Headers();
    quoted.append('Idempotency-Key', '"one"');
    quoted.append('Idempotency-Key', '"two"');
    expect(lookupKey(quoted, 'Idempotency-Key', 'strict').kind).toBe('invalid');
  });

  test('REQ-HTTP-4: strict syntax rejects a bare token and lenient accepts it', () => {
    const headers = new Headers({ 'Idempotency-Key': 'bare-token' });
    expect(lookupKey(headers, 'Idempotency-Key', 'strict').kind).toBe('invalid');
    expect(lookupKey(headers, 'Idempotency-Key', 'lenient')).toEqual({
      kind: 'ok',
      key: 'bare-token',
    });
    expect(
      lookupKey(new Headers({ 'Idempotency-Key': '"quoted key"' }), 'Idempotency-Key', 'strict'),
    ).toEqual({ kind: 'ok', key: 'quoted key' });
  });

  test('REQ-HTTP-2: the invalid reason never contains the key value', () => {
    const headers = new Headers({ 'Idempotency-Key': 'has space inside' });
    const result = lookupKey(headers, 'Idempotency-Key', 'lenient');
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).not.toContain('has space');
  });
});

describe('scope', () => {
  test('REQ-HTTP-5: the default scope is METHOD and pathname without the query', () => {
    expect(defaultScope(post('/orders?x=1'))).toBe('POST /orders');
    expect(requestPath(post('/orders?x=1'))).toBe('/orders?x=1');
  });

  test('REQ-HTTP-5: the default scope keeps percent encoding so it matches the Go scope', () => {
    expect(defaultScope(post('/users/john%40example.com'))).toBe('POST /users/john%40example.com');
  });

  test('REQ-HTTP-5: a route scope wins over the pathname and a scope option wins over both', () => {
    const plain = resolveHttpOptions({ store });
    expect(resolveScope(post('/orders/42'), plain, 'POST /orders/:id')).toEqual({
      ok: true,
      scope: 'POST /orders/:id',
    });
    const custom = resolveHttpOptions({ store, scope: () => 'custom' });
    expect(resolveScope(post('/orders/42'), custom, 'POST /orders/:id')).toEqual({
      ok: true,
      scope: 'custom',
    });
  });

  test('REQ-HTTP-5: a principal is appended after a hash and a missing one is a 500 only when required', () => {
    const withPrincipal = resolveHttpOptions({
      store,
      principal: (req) => req.headers.get('x-tenant') ?? undefined,
    });
    expect(resolveScope(post('/p', 'b', { 'x-tenant': 'acme' }), withPrincipal)).toEqual({
      ok: true,
      scope: 'POST /p#acme',
    });
    expect(resolveScope(post('/p'), withPrincipal)).toEqual({ ok: true, scope: 'POST /p' });
    const required = resolveHttpOptions({
      store,
      requirePrincipal: true,
      principal: (req) => req.headers.get('x-tenant') ?? undefined,
    });
    expect(resolveScope(post('/p'), required)).toEqual({ ok: false, code: 'missing-principal' });
  });
});

describe('readBody', () => {
  test('REQ-HTTP-6: reads the body once and leaves the original request readable', async () => {
    const req = post('/p', 'payload');
    const read = await readBody(req, 1024);
    expect(read).toEqual({ ok: true, body: enc.encode('payload') });
    expect(await req.text()).toBe('payload');
  });

  test('REQ-HTTP-6: a body over maxRequestBytes is rejected before the handler sees it', async () => {
    const declared = post('/p', 'x'.repeat(10), { 'content-length': '10' });
    expect(await readBody(declared, 9)).toEqual({ ok: false, code: 'payload-too-large' });
    const undeclared = new Request('http://t.invalid/p', {
      method: 'POST',
      body: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('12345'));
          c.enqueue(enc.encode('67890'));
          c.close();
        },
      }),
      // @ts-expect-error duplex is required for stream bodies in Node and Bun but is not in lib.dom
      duplex: 'half',
    });
    expect(await readBody(undeclared, 9)).toEqual({ ok: false, code: 'payload-too-large' });
  });

  test('REQ-HTTP-6: a request without a body reads as zero bytes', async () => {
    expect(await readBody(post('/p'), 10)).toEqual({ ok: true, body: new Uint8Array(0) });
  });
});

describe('requestFingerprint', () => {
  test('REQ-HTTP-6: body mode is httpFingerprint over method, path with query and bytes', async () => {
    const req = post('/orders?x=1', 'abc');
    expect(await requestFingerprint(req, enc.encode('abc'), 'body')).toBe(
      await httpFingerprint('POST', '/orders?x=1', enc.encode('abc')),
    );
  });

  test('REQ-HTTP-6: jcs mode gives one fingerprint for two spellings of the same JSON', async () => {
    const a = await requestFingerprint(post('/p'), enc.encode('{"a":1,"b":[1,2]}'), 'jcs');
    const b = await requestFingerprint(
      post('/p'),
      enc.encode(' { "b" : [1, 2], "a" : 1 } '),
      'jcs',
    );
    expect(a).toBe(b);
    const expected = await sha256Hex(enc.encode(`POST\n/p\n{"a":1,"b":[1,2]}`));
    expect(a).toBe(expected);
    expect(a).not.toBe(await jcsFingerprint({ a: 1, b: [1, 2] }));
  });

  test('REQ-HTTP-6: jcs mode falls back to the byte form when the body is not JSON', async () => {
    const body = enc.encode('not json');
    expect(await requestFingerprint(post('/p'), body, 'jcs')).toBe(
      await httpFingerprint('POST', '/p', body),
    );
  });

  test('REQ-HTTP-6: a custom function receives the request and the bytes', async () => {
    const custom = await requestFingerprint(
      post('/p', 'abc', { 'x-v': '2' }),
      enc.encode('abc'),
      async (req, body) => `${req.headers.get('x-v')}:${body.byteLength}`,
    );
    expect(custom).toBe('2:3');
  });
});
