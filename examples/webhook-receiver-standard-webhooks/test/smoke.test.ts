import { describe, expect, test } from 'bun:test';
import { generateSecret, Signer } from '@anyhook/signing';
import { MemoryStore, type Store } from '@anyonce/core';
import { createApp, type WebhookEvent } from '../src/index';
import { signatureHeaders } from '../src/sign';

const ENDPOINT = 'https://example.test/webhooks';

function deliver(headers: Record<string, string>, payload: string): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
  });
}

/** A store that counts every call, so a test can prove the receiver never reached it. */
function countingStore(inner: Store): { store: Store; calls: () => number } {
  let calls = 0;
  const store: Store = {
    begin: (...args) => {
      calls += 1;
      return inner.begin(...args);
    },
    complete: (...args) => {
      calls += 1;
      return inner.complete(...args);
    },
    abandon: (...args) => {
      calls += 1;
      return inner.abandon(...args);
    },
    get: (...args) => {
      calls += 1;
      return inner.get(...args);
    },
    purge: (...args) => {
      calls += 1;
      return inner.purge(...args);
    },
  };
  return { store, calls: () => calls };
}

describe('webhook-receiver-standard-webhooks', () => {
  test('REQ-DOC-7: webhook receiver runs a signed delivery once and replays the redelivery', async () => {
    const secret = generateSecret();
    const received: WebhookEvent[] = [];
    const handler = createApp({
      store: new MemoryStore(),
      secret,
      onEvent: (event) => received.push(event),
    });
    const payload = '{"type":"invoice.paid","data":{"invoice":"inv_1"}}';
    // Signed by anyhook, an independent Standard Webhooks sender.
    const signer = new Signer(secret);

    const first = await handler(deliver(signer.headers('msg_readme_1', payload), payload));
    expect(first.status).toBe(200);
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();
    const body = await first.text();

    // A redelivery carries the same webhook-id; senders sign it afresh.
    const again = await handler(deliver(signer.headers('msg_readme_1', payload), payload));
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await again.text()).toBe(body);
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('invoice.paid');

    // The example's own signer (what the README uses with curl) produces headers the receiver accepts too.
    const tampered = '{"type":"invoice.paid","data":{"invoice":"inv_2"}}';
    const changed = await handler(
      deliver(await signatureHeaders(secret, 'msg_readme_1', tampered), tampered),
    );
    expect(changed.status).toBe(422);
    expect(((await changed.json()) as { code: string }).code).toBe('fingerprint-mismatch');
    expect(received).toHaveLength(1);

    const other = await handler(
      deliver(await signatureHeaders(secret, 'msg_readme_2', tampered), tampered),
    );
    expect(other.status).toBe(200);
    expect(received).toHaveLength(2);
  });

  test('REQ-DOC-7: webhook receiver rejects an unsigned delivery before touching the store', async () => {
    const { store, calls } = countingStore(new MemoryStore());
    const received: WebhookEvent[] = [];
    const handler = createApp({
      store,
      secret: generateSecret(),
      onEvent: (event) => received.push(event),
    });
    const payload = '{"type":"invoice.paid"}';
    const unsigned = await handler(
      deliver(
        { 'webhook-id': 'msg_unsigned_1', 'webhook-timestamp': `${Math.floor(Date.now() / 1000)}` },
        payload,
      ),
    );
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get('WWW-Authenticate')).toBe('Signature');
    expect(((await unsigned.json()) as { code: string }).code).toBe('signature-invalid');

    const wrongSecret = new Signer(generateSecret()).headers('msg_unsigned_2', payload);
    const forged = await handler(deliver(wrongSecret, payload));
    expect(forged.status).toBe(401);
    expect(forged.headers.get('WWW-Authenticate')).toBe('Signature');

    // A correctly signed delivery to a path the example does not serve is 404 without a record either.
    const secret = generateSecret();
    const { store: routedStore, calls: routedCalls } = countingStore(new MemoryStore());
    const routed = createApp({
      store: routedStore,
      secret,
      onEvent: (event) => received.push(event),
    });
    const elsewhere = await routed(
      new Request('https://example.test/elsewhere', {
        method: 'POST',
        headers: {
          ...new Signer(secret).headers('msg_unknown_path', payload),
          'Content-Type': 'application/json',
        },
        body: payload,
      }),
    );
    expect(elsewhere.status).toBe(404);
    expect(routedCalls()).toBe(0);

    expect(calls()).toBe(0);
    expect(received).toHaveLength(0);
  });
});
