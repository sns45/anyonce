import { describe, expect, test } from 'bun:test';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { runConformance } from '../src/conformance';
import { BARE_PASS_IDS, CORE_IDS } from './catalog';

describe('runConformance', () => {
  test('REQ-CONF-5: runs the selected tiers against a fetch handler and returns the summary and the report', async () => {
    const app = createFixtureApp();
    const { summary, report } = await runConformance({
      target: app.fetch,
      tiers: ['core'],
      report: 'markdown',
    });
    expect(summary.results.map((r) => r.id)).toEqual(CORE_IDS);
    expect(summary.results.find((r) => r.id === 'core/expiry-executes-again')?.status).toBe(
      'not-applicable',
    );
    expect(summary.passed).toBe(
      BARE_PASS_IDS.filter((id) => id.startsWith('core/') && id !== 'core/expiry-executes-again')
        .length,
    );
    expect(report).toContain('# anyonce conformance report');
    expect(report).toContain('Target: in-process fetch handler');
  }, 60_000);

  test('REQ-CONF-5: only narrows the run to the named vectors', async () => {
    const { summary } = await runConformance({
      target: createFixtureApp().fetch,
      only: ['core/post-executes-once'],
    });
    expect(summary.results.map((r) => r.id)).toEqual(['core/post-executes-once']);
    expect(summary.passed).toBe(1);
  });
});
