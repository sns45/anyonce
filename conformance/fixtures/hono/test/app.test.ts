import { describe, expect, test } from 'bun:test';
import { createFixtureApp } from '../src/app';

function post(path: string, body = 'b', headers: Record<string, string> = {}): Request {
  return new Request(`http://fixture.invalid${path}`, { method: 'POST', body, headers });
}

describe('hono fixture', () => {
  test('REQ-CONF-2: POST /echo returns 201 with the body and content type echoed and increments the counter', async () => {
    const app = createFixtureApp();
    const res = await app.fetch(post('/echo', 'hello', { 'Content-Type': 'text/plain' }));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('hello');
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const counter = await app.fetch(new Request('http://fixture.invalid/counter'));
    expect(await counter.json()).toEqual({ count: 1 });
  });

  test('REQ-CONF-2: POST /status/{code} returns that status with body status:{code} and counts', async () => {
    const app = createFixtureApp();
    const res = await app.fetch(post('/status/404'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('status:404');
    const res500 = await app.fetch(post('/status/500'));
    expect(res500.status).toBe(500);
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({
      count: 2,
    });
  });

  test('REQ-CONF-2: POST /status with a non-status code returns 400 and does not count', async () => {
    const app = createFixtureApp();
    const res = await app.fetch(post('/status/abc'));
    expect(res.status).toBe(400);
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({
      count: 0,
    });
  });

  test('REQ-CONF-2: POST /slow?ms=N waits at least N ms then returns slept:N', async () => {
    const app = createFixtureApp();
    const start = Date.now();
    const res = await app.fetch(post('/slow?ms=120'));
    expect(Date.now() - start).toBeGreaterThanOrEqual(115);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('slept:120');
  });

  test('REQ-CONF-2: POST /large?bytes=N returns exactly N bytes', async () => {
    const app = createFixtureApp();
    const res = await app.fetch(post('/large?bytes=70000'));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(70000);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  test('REQ-CONF-2: POST /reset clears the counter and GET /counter reports it', async () => {
    const app = createFixtureApp();
    await app.fetch(post('/echo'));
    await app.fetch(post('/slow?ms=0'));
    await app.fetch(post('/large?bytes=1'));
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({
      count: 3,
    });
    const reset = await app.fetch(post('/reset', ''));
    expect(reset.status).toBe(204);
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({
      count: 0,
    });
  });

  test('REQ-CONF-2: the fixture has no idempotency layer, a repeated key executes again', async () => {
    const app = createFixtureApp();
    await app.fetch(post('/echo', 'a', { 'Idempotency-Key': 'k' }));
    const second = await app.fetch(post('/echo', 'a', { 'Idempotency-Key': 'k' }));
    expect(second.headers.get('Idempotency-Replayed')).toBeNull();
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({
      count: 2,
    });
  });
});
