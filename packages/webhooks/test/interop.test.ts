import { describe, expect, test } from 'bun:test';
import { generateSecret, Signer } from '@anyhook/signing';
import type { IdempotencyRecord } from '@anyonce/core';
import { MemoryStore } from '@anyonce/core';
import { standardWebhooksVerify, webhookReceiver } from '../src/index';

function deliver(secret: string, id: string, payload: string): Request {
  const headers = new Signer(secret).headers(id, payload);
  return new Request('https://example.test/hooks/anyhook', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
  });
}

describe('anyhook interop', () => {
  test('REQ-WH-6: a delivery signed by anyhook is accepted, and the redelivery replays', async () => {
    const secret = generateSecret();
    const store = new MemoryStore();
    let runs = 0;
    const handler = webhookReceiver({ store, verify: standardWebhooksVerify(secret) })(async () => {
      runs += 1;
      return new Response('{"received":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const first = await handler(deliver(secret, 'msg_interop_1', '{"event":"payment.succeeded"}'));
    expect(first.status).toBe(200);
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();
    // The stored copy settles only once the first response body is drained (packages/core/src/http/capture.ts);
    // receiver.test.ts follows the same pattern before a same-body redelivery.
    await first.text();

    const second = await handler(deliver(secret, 'msg_interop_1', '{"event":"payment.succeeded"}'));
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await second.text()).toBe('{"received":true}');
    expect(runs).toBe(1);
  });

  test('REQ-WH-6: a delivery signed with a different secret is 401 and never runs the handler', async () => {
    const store = new MemoryStore();
    let runs = 0;
    const handler = webhookReceiver({ store, verify: standardWebhooksVerify(generateSecret()) })(
      async () => {
        runs += 1;
        return new Response('handled');
      },
    );
    const res = await handler(deliver(generateSecret(), 'msg_interop_2', '{"a":1}'));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('signature-invalid');
    expect(runs).toBe(0);
  });

  test('REQ-WH-6: a rotation signature from anyhook verifies against either secret the receiver holds', async () => {
    const older = generateSecret();
    const newer = generateSecret();
    const payload = '{"event":"rotated"}';
    const headers = new Signer([older, newer]).headers('msg_interop_3', payload);
    const req = new Request('https://example.test/hooks/anyhook', {
      method: 'POST',
      headers,
      body: payload,
    });
    const verify = standardWebhooksVerify(newer);
    expect(await verify(req, new TextEncoder().encode(payload))).toBe(true);
  });

  test('REQ-WH-5: a tampered body under a signed id that already landed is 422 and fires onSuspicious', async () => {
    const secret = generateSecret();
    const store = new MemoryStore();
    const suspicious: IdempotencyRecord[] = [];
    const handler = webhookReceiver({
      store,
      verify: standardWebhooksVerify(secret),
      onSuspicious: (_req, record) => {
        suspicious.push(record);
      },
    })(async () => new Response('handled'));

    await handler(deliver(secret, 'msg_interop_4', '{"amount":10}'));
    const tampered = await handler(deliver(secret, 'msg_interop_4', '{"amount":9000}'));
    expect(tampered.status).toBe(422);
    expect(((await tampered.json()) as { code: string }).code).toBe('fingerprint-mismatch');
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]?.key).toBe('msg_interop_4');
  });
});
