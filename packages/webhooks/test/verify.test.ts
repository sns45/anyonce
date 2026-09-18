import { describe, expect, test } from 'bun:test';
import { standardWebhooksVerify } from '../src/index';

const encoder = new TextEncoder();

const SECRET_A = 'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB';
const SECRET_B = 'whsec_AgIBAQEBAQEBAQEBAQEBAQEBAQEBAQEB';

interface Vector {
  name: string;
  secrets: string[];
  id: string;
  payload: string;
  timestamp: number;
  signature: string;
}

const VECTORS: Vector[] = [
  {
    name: 'single_secret',
    secrets: [SECRET_A],
    id: 'msg_1',
    payload: '{"a":1}',
    timestamp: 1700000000,
    signature: 'v1,g9EIBBIwm31AQEkP7q60DV8jDWYbrjV7TTZJL+PIcMo=',
  },
  {
    name: 'rotation_two_secrets',
    secrets: [SECRET_A, SECRET_B],
    id: 'msg_2',
    payload: '{"nested":{"b":[1,2,3]},"unicode":"café"}',
    timestamp: 1700000001,
    signature:
      'v1,Quo14+anAi2BEdvq/rAJ6acir9k1eo5oapk44aRYF6Y= v1,DA4ZWdZKEG9r6wHFCDZPQA+nmyvCvC6qn44us/GbmOw=',
  },
  {
    name: 'empty_object_payload',
    secrets: [SECRET_A],
    id: 'msg_3',
    payload: '{}',
    timestamp: 0,
    signature: 'v1,rPUBbAcJfBgq5bbh2lc3N+SdRs/ySWgI2QxJlbKwSBU=',
  },
];

function signed(v: Vector, overrides: Record<string, string> = {}): Request {
  return new Request('https://example.test/hooks', {
    method: 'POST',
    headers: {
      'webhook-id': v.id,
      'webhook-timestamp': String(v.timestamp),
      'webhook-signature': v.signature,
      ...overrides,
    },
    body: v.payload,
  });
}

describe('standardWebhooksVerify', () => {
  for (const v of VECTORS) {
    test(`REQ-WH-6: the ${v.name} anyhook golden vector verifies`, async () => {
      const verify = standardWebhooksVerify(v.secrets[0] as string, {
        clock: () => v.timestamp * 1000,
      });
      expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
    });
  }

  test('REQ-WH-6: a rotation signature verifies against either secret', async () => {
    const v = VECTORS[1] as Vector;
    for (const secret of v.secrets) {
      const verify = standardWebhooksVerify(secret, { clock: () => v.timestamp * 1000 });
      expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
    }
  });

  test('REQ-WH-6: a receiver holding two secrets verifies a payload signed with either', async () => {
    const v = VECTORS[1] as Vector;
    const verify = standardWebhooksVerify(v.secrets, { clock: () => v.timestamp * 1000 });
    expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
  });

  test('REQ-WH-6: a secret without the whsec_ prefix is the same key', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB', {
      clock: () => v.timestamp * 1000,
    });
    expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
  });

  test('REQ-WH-6: a changed body fails', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => v.timestamp * 1000,
    });
    expect(await verify(signed(v), encoder.encode('{"a":2}'))).toBe(false);
  });

  test('REQ-WH-6: a changed id fails', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => v.timestamp * 1000,
    });
    expect(await verify(signed(v, { 'webhook-id': 'msg_other' }), encoder.encode(v.payload))).toBe(
      false,
    );
  });

  test('REQ-WH-6: each of the three headers is required', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => v.timestamp * 1000,
    });
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const req = signed(v);
      req.headers.delete(name);
      expect(await verify(req, encoder.encode(v.payload))).toBe(false);
    }
  });

  test('REQ-WH-6: the headers are matched case-insensitively', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => v.timestamp * 1000,
    });
    const req = new Request('https://example.test/hooks', {
      method: 'POST',
      headers: {
        'Webhook-Id': v.id,
        'Webhook-Timestamp': String(v.timestamp),
        'Webhook-Signature': v.signature,
      },
      body: v.payload,
    });
    expect(await verify(req, encoder.encode(v.payload))).toBe(true);
  });

  test('REQ-WH-6: a timestamp that is not a finite number fails', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => v.timestamp * 1000,
    });
    expect(
      await verify(signed(v, { 'webhook-timestamp': 'yesterday' }), encoder.encode(v.payload)),
    ).toBe(false);
  });

  test('REQ-WH-6: a timestamp outside the 300 second tolerance fails on either side', async () => {
    const v = VECTORS[0] as Vector;
    const late = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => (v.timestamp + 301) * 1000,
    });
    const early = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => (v.timestamp - 301) * 1000,
    });
    expect(await late(signed(v), encoder.encode(v.payload))).toBe(false);
    expect(await early(signed(v), encoder.encode(v.payload))).toBe(false);
  });

  test('REQ-WH-6: a timestamp at the tolerance edge still verifies', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => (v.timestamp + 300) * 1000,
    });
    expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
  });

  test('REQ-WH-6: a fractional timestamp is accepted and truncated, matching anyhook', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => v.timestamp * 1000,
    });
    expect(
      await verify(
        signed(v, { 'webhook-timestamp': `${v.timestamp}.75` }),
        encoder.encode(v.payload),
      ),
    ).toBe(true);
  });

  test('REQ-WH-6: an entry with an unknown version prefix is ignored and the rest still decide', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => v.timestamp * 1000,
    });
    expect(
      await verify(
        signed(v, { 'webhook-signature': `v2,abc ${v.signature}` }),
        encoder.encode(v.payload),
      ),
    ).toBe(true);
    expect(
      await verify(signed(v, { 'webhook-signature': 'v2,abc' }), encoder.encode(v.payload)),
    ).toBe(false);
  });

  test('REQ-WH-6: a signature entry that is not base64 fails instead of throwing', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => v.timestamp * 1000,
    });
    expect(
      await verify(
        signed(v, { 'webhook-signature': 'v1,!!!not base64!!!' }),
        encoder.encode(v.payload),
      ),
    ).toBe(false);
  });

  test('REQ-WH-6: a secret whose base64 does not decode throws at construction, not per request', () => {
    expect(() => standardWebhooksVerify('whsec_!!!')).toThrow();
  });
});
