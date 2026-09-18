import { describe, expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { MemoryStore } from '@anyonce/core';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { CORE_IDS, PROFILE_IDS } from '../../conformance/test/catalog';
import { webhookReceiver } from '../src/index';

describe('webhook receiver conformance', () => {
  test('REQ-WH-1: every core and profile vector passes through the receiver with the memory store', async () => {
    const app = createFixtureApp();
    // Q28: the vectors carry the HTTP door's header and no signature, so the id header is pointed at the vector
    // header and verification is a constant true. The gate itself is proven by packages/webhooks/test/gate.test.ts.
    // POST /reset is the runner's control path and is skipped, exactly as the withIdempotency harness does.
    const handler = webhookReceiver({
      store: new MemoryStore(),
      idHeader: 'Idempotency-Key',
      verify: () => true,
      required: true,
      ttlMs: 2000,
      // The vectors assert the HTTP door's fingerprint, which includes the method and the path, so the harness
      // asks for it explicitly rather than the body only default (D9 gives the webhook door the body form).
      fingerprint: 'body',
      routePattern: (req) => `${req.method} ${new URL(req.url).pathname}`,
      skip: (req) => new URL(req.url).pathname === '/reset',
    })(app.fetch);

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
  }, 60_000);
});
