import { describe, expect, test } from 'bun:test';
import { captureResponse, replayResponse, storedHeaders } from '../../src/http/capture';
import type { IdempotencyRecord } from '../../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const allow = new Set(['content-type', 'location', 'etag']);

function streamOf(parts: string[], gate?: Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const [i, part] of parts.entries()) {
        if (i === 1 && gate) await gate;
        controller.enqueue(enc.encode(part));
      }
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return dec.decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

describe('storedHeaders', () => {
  test('REQ-HTTP-8: keeps allowlisted headers, lowercased, and never Set-Cookie', () => {
    const headers = new Headers({
      'Content-Type': 'text/plain',
      'X-Other': '1',
      ETag: '"v1"',
      'Set-Cookie': 'a=1',
    });
    expect(storedHeaders(headers, new Set([...allow, 'set-cookie']))).toEqual([
      ['content-type', 'text/plain'],
      ['etag', '"v1"'],
    ]);
  });
});

describe('captureResponse', () => {
  test('REQ-HTTP-7: chunks reach the client before the source finishes and the stored copy has every byte', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const res = new Response(streamOf(['first', 'second'], gate), {
      status: 201,
      headers: { 'Content-Type': 'text/plain', 'X-Other': '1' },
    });
    const capture = captureResponse(res, allow, 1024);
    expect(capture.streaming).toBe(true);
    expect(capture.response.status).toBe(201);
    expect(capture.response.headers.get('X-Other')).toBe('1');
    const reader = (capture.response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe('first');
    release();
    const second = await reader.read();
    expect(dec.decode(second.value)).toBe('second');
    const stored = await capture.stored;
    expect(stored).toEqual({
      kind: 'http',
      status: 201,
      headers: [['content-type', 'text/plain']],
      body: enc.encode('firstsecond'),
    });
    let closed = false;
    const pending = reader.read().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    capture.close();
    await pending;
    expect(closed).toBe(true);
  });

  test('REQ-HTTP-7: the stored body stops growing past the cap but stays larger than the cap', async () => {
    const res = new Response(streamOf(['aaaa', 'bbbb', 'cccc', 'dddd']), { status: 200 });
    const capture = captureResponse(res, allow, 5);
    const client = readAll(capture.response.body as ReadableStream<Uint8Array>);
    const stored = await capture.stored;
    capture.close();
    expect(await client).toBe('aaaabbbbccccdddd');
    expect(stored.body?.byteLength).toBe(8);
  });

  test('REQ-HTTP-7: a bodiless response is not streaming and stores zero bytes', async () => {
    const res = new Response(null, { status: 204, headers: { Location: '/x' } });
    const capture = captureResponse(res, allow, 1024);
    expect(capture.streaming).toBe(false);
    expect(capture.response.status).toBe(204);
    expect(await capture.stored).toEqual({
      kind: 'http',
      status: 204,
      headers: [['location', '/x']],
      body: new Uint8Array(0),
    });
  });

  test('REQ-HTTP-12: extra headers are added to the client response only', async () => {
    const res = new Response('x', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    const capture = captureResponse(res, allow, 1024, [['Idempotency-Degraded', 'true']]);
    expect(capture.response.headers.get('Idempotency-Degraded')).toBe('true');
    // The pump is pull driven, so the record only settles once the client has read the body.
    const client = readAll(capture.response.body as ReadableStream<Uint8Array>);
    expect((await capture.stored).headers).toEqual([['content-type', 'text/plain']]);
    capture.close();
    expect(await client).toBe('x');
  });

  test('REQ-HTTP-7: a failing source rejects stored and errors the client stream', async () => {
    const res = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('a'));
          c.error(new Error('boom'));
        },
      }),
    );
    const capture = captureResponse(res, allow, 1024);
    // The pump is pull driven, so the failure is discovered when the client reads, not before.
    await expect(readAll(capture.response.body as ReadableStream<Uint8Array>)).rejects.toThrow(
      'boom',
    );
    await expect(capture.stored).rejects.toThrow('boom');
  });

  test('REQ-HTTP-7: the source is pulled at the client pace', async () => {
    let pulls = 0;
    let finish = false;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        if (finish) {
          c.close();
          return;
        }
        c.enqueue(new Uint8Array(64));
      },
    });
    const capture = captureResponse(new Response(source), allow, 1024 * 1024);
    // An upper bound, not a race: a free running pump would have drained far past this by now.
    await new Promise((r) => setTimeout(r, 0));
    expect(pulls).toBeLessThanOrEqual(2);
    const before = pulls;
    const reader = (capture.response.body as ReadableStream<Uint8Array>).getReader();
    for (let i = 0; i < 3; i += 1) {
      const chunk = await reader.read();
      expect(chunk.value?.byteLength).toBe(64);
    }
    expect(pulls - before).toBeLessThanOrEqual(4);
    finish = true;
    await reader.cancel('client gone');
    const stored = await capture.stored;
    expect(stored.body?.byteLength).toBeGreaterThan(0);
    expect((stored.body?.byteLength ?? 1) % 64).toBe(0);
  });

  test('REQ-HTTP-7: fail() errors a client stream that is still open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const capture = captureResponse(new Response(streamOf(['a', 'b'], gate)), allow, 1024);
    const client = readAll(capture.response.body as ReadableStream<Uint8Array>);
    capture.fail(new Error('abandoned'));
    release();
    await expect(client).rejects.toThrow('abandoned');
    await expect(capture.stored).rejects.toThrow('abandoned');
  });

  test('REQ-HTTP-7: a client cancel does not stop the drain and the stored copy still holds every byte', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const res = new Response(streamOf(['first', 'second'], gate), { status: 200 });
    const capture = captureResponse(res, allow, 1024);
    const reader = (capture.response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe('first');
    await reader.cancel('client gone');
    release();
    const stored = await capture.stored;
    expect(dec.decode(stored.body)).toBe('firstsecond');
    expect(() => capture.close()).not.toThrow();
  });
});

describe('replayResponse', () => {
  const base: IdempotencyRecord = {
    scope: 'POST /p',
    key: 'k',
    fingerprint: 'f',
    state: 'completed',
    fence: 1,
    leaseUntil: 0,
    createdAt: 0,
    expiresAt: 10,
  };

  test('REQ-HTTP-9: replays status, stored headers and body and marks Idempotency-Replayed', async () => {
    const res = replayResponse({
      ...base,
      result: {
        kind: 'http',
        status: 201,
        headers: [['content-type', 'text/plain']],
        body: enc.encode('hi'),
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(res.headers.get('Idempotency-Replay')).toBeNull();
    expect(await res.text()).toBe('hi');
  });

  test('REQ-HTTP-9: an omitted result replays status and headers with an empty body and Idempotency-Replay omitted (D12)', async () => {
    const res = replayResponse({
      ...base,
      resultOmitted: true,
      result: {
        kind: 'http',
        status: 200,
        headers: [['content-type', 'application/octet-stream']],
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(res.headers.get('Idempotency-Replay')).toBe('omitted');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test('REQ-HTTP-9: a stored 204 replays without a body', async () => {
    const res = replayResponse({
      ...base,
      result: { kind: 'http', status: 204, body: new Uint8Array(0) },
    });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});
