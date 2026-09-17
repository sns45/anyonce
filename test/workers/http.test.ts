import type { Vector } from '@anyonce/conformance/runtime';
import { runVectors } from '@anyonce/conformance/runtime';
import { MemoryStore } from '@anyonce/core';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { idempotency } from '@anyonce/hono';
import { describe, expect, test } from 'vitest';

const modules = import.meta.glob('../../conformance/vectors/{core,profile}/*.json', {
  eager: true,
  import: 'default',
});
const vectors = Object.values(modules) as Vector[];

function report(
  results: Array<{
    id: string;
    status: string;
    steps: Array<{ stepId: string; failures: string[] }>;
    error?: string;
  }>,
): string {
  return results
    .filter((r) => r.status !== 'pass')
    .map(
      (r) =>
        `${r.id}: ${r.status} ${r.error ?? ''} ${r.steps.flatMap((s) => s.failures.map((f) => `${s.stepId}: ${f}`)).join('; ')}`,
    )
    .join('\n');
}

describe('workerd', () => {
  test('NFR-4: every vector passes inside workerd through withIdempotency', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    expect(vectors.length).toBe(20);
    const app = createFixtureApp();
    const handler = withIdempotency(app.fetch, {
      store: new MemoryStore(),
      required: true,
      ttlMs: 2000,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    const summary = await runVectors(handler, vectors, { capabilities: ['short-ttl'] });
    expect(report(summary.results), report(summary.results)).toBe('');
    expect(summary.passed).toBe(vectors.length);
  }, 60_000);

  test('NFR-4: every vector passes inside workerd through the Hono middleware', async () => {
    expect(vectors.length).toBe(20);
    const app = createFixtureApp(
      { count: 0 },
      idempotency({ store: new MemoryStore(), required: true, ttlMs: 2000 }),
    );
    const summary = await runVectors(app.fetch, vectors, { capabilities: ['short-ttl'] });
    expect(report(summary.results), report(summary.results)).toBe('');
    expect(summary.passed).toBe(vectors.length);
  }, 60_000);
});
