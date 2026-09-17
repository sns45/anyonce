import { describe, expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { MemoryStore } from '@anyonce/core';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { CORE_IDS, PROFILE_IDS } from '../../conformance/test/catalog';
import { idempotency } from '../src';

describe('hono conformance', () => {
  test('REQ-HTTP-16: every core and profile vector passes through the Hono middleware with the memory store', async () => {
    const app = createFixtureApp(
      { count: 0 },
      idempotency({ store: new MemoryStore(), required: true, ttlMs: 2000 }),
    );
    const { summary, report } = await runConformance({
      target: app.fetch,
      capabilities: ['short-ttl'],
      report: 'markdown',
    });
    const notPassing = summary.results
      .filter((r) => r.status !== 'pass')
      .map((r) => `${r.id}: ${r.status}`);
    expect(notPassing, report).toEqual([]);
    expect(summary.passed).toBe(CORE_IDS.length + PROFILE_IDS.length);
  }, 60_000);
});
