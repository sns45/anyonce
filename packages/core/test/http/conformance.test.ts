import { describe, expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { CORE_IDS, PROFILE_IDS } from '../../../conformance/test/catalog';
import { withIdempotency } from '../../src/http';
import { MemoryStore } from '../../src/memory';

describe('withIdempotency conformance', () => {
  test('REQ-HTTP-17: every core and profile vector passes through withIdempotency with the memory store', async () => {
    const app = createFixtureApp();
    const handler = withIdempotency(app.fetch, {
      store: new MemoryStore(),
      required: true,
      ttlMs: 2000,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    const { summary, report } = await runConformance({
      target: handler,
      capabilities: ['short-ttl'],
      report: 'markdown',
    });
    const notPassing = summary.results
      .filter((r) => r.status !== 'pass')
      .map((r) => `${r.id}: ${r.status}`);
    expect(notPassing, report).toEqual([]);
    expect(summary.results).toHaveLength(CORE_IDS.length + PROFILE_IDS.length);
    expect(summary.passed).toBe(CORE_IDS.length + PROFILE_IDS.length);
  }, 60_000);
});
