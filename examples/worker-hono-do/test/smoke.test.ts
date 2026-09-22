import { env, SELF } from 'cloudflare:test';
import { runConformance, type Vector } from '@anyonce/conformance/runtime';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { idempotency } from '@anyonce/hono';
import type { IdempotencyObject } from '@anyonce/stores/durable-objects';
import { DurableObjectsStore } from '@anyonce/stores/durable-objects';
import { describe, expect, test } from 'vitest';
import { idempotencyOptions } from '../src/index';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    IDEMPOTENCY: DurableObjectNamespace<IdempotencyObject>;
  }
}

function order(key: string, body: string): Promise<Response> {
  return SELF.fetch('https://example.test/orders', {
    method: 'POST',
    headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
    body,
  });
}

describe('worker-hono-do', () => {
  test('REQ-DOC-7: worker-hono-do replays a completed POST', async () => {
    // The README scenario, through the Worker entry itself (SELF is the main module in wrangler.jsonc).
    const first = await order('order-readme-1', '{"item":"book"}');
    expect(first.status).toBe(201);
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();
    const created = (await first.json()) as { id: string; item: string };
    expect(created.item).toBe('book');

    const second = await order('order-readme-1', '{"item":"book"}');
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await second.json()).toEqual(created);

    const changed = await order('order-readme-1', '{"item":"lamp"}');
    expect(changed.status).toBe(422);
    expect(changed.headers.get('Content-Type')).toContain('application/problem+json');
    expect(((await changed.json()) as { code: string }).code).toBe('fingerprint-mismatch');
  });

  test('REQ-HTTP-17: worker-hono-do passes the core and profile conformance tiers in workerd', async () => {
    const modules = import.meta.glob('../../../conformance/vectors/{core,profile}/*.json', {
      eager: true,
      import: 'default',
    });
    const vectors = Object.values(modules) as Vector[];
    expect(vectors.length).toBe(20);
    // The fixture routes behind the example's own middleware configuration. Only the TTL differs, so the
    // short-ttl vector can prove expiry inside the test's time budget.
    const store = new DurableObjectsStore({ namespace: env.IDEMPOTENCY });
    const app = createFixtureApp(
      { count: 0 },
      idempotency(idempotencyOptions({ store, ttlMs: 2000 })),
    );
    const { summary, report } = await runConformance({
      target: app.fetch,
      vectors,
      capabilities: ['short-ttl'],
      report: 'markdown',
    });
    expect(
      summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`),
      report,
    ).toEqual([]);
    expect(summary.passed).toBe(20);
  });
});
