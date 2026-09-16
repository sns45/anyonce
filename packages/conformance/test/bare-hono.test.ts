import { describe, expect, test } from 'bun:test';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { loadVectors } from '../src/load';
import { runVectors } from '../src/run';
import { BARE_PASS_IDS, CORE_IDS, PROFILE_IDS } from './catalog';

describe('bare hono fixture', () => {
  test('REQ-CONF-2: with no idempotency layer the runner fails every vector except the execution-only ones', async () => {
    const app = createFixtureApp();
    const summary = await runVectors(app.fetch, loadVectors(), { capabilities: ['short-ttl'] });
    expect(summary.results).toHaveLength(CORE_IDS.length + PROFILE_IDS.length);
    expect(summary.errored).toBe(0);
    expect(summary.notApplicable).toBe(0);
    const passed = summary.results
      .filter((r) => r.status === 'pass')
      .map((r) => r.id)
      .sort();
    expect(passed).toEqual(BARE_PASS_IDS);
    const failed = summary.results
      .filter((r) => r.status === 'fail')
      .map((r) => r.id)
      .sort();
    expect(failed).toEqual(
      [...CORE_IDS, ...PROFILE_IDS].filter((id) => !BARE_PASS_IDS.includes(id)).sort(),
    );
  }, 30_000);

  test('REQ-CONF-2: every failure on the bare fixture is a status or counter mismatch, never a runner error', async () => {
    const app = createFixtureApp();
    const summary = await runVectors(app.fetch, loadVectors(), { tiers: ['core'] });
    for (const result of summary.results) {
      for (const step of result.steps) {
        for (const failure of step.failures) {
          expect(failure).toMatch(/^(status|handlerInvocations|header [A-Za-z-]+|body):/);
        }
      }
    }
  }, 30_000);
});
