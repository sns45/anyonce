import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { loadVectors } from '../src/load';
import { runConformance } from '../src/runtime';

describe('runtime entry', () => {
  test('REQ-CONF-5: the runtime entry bundles without any node: import', async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, '../src/runtime.ts')],
      target: 'browser',
      minify: false,
    });
    expect(result.success).toBe(true);
    const text = await (result.outputs[0] as { text(): Promise<string> }).text();
    expect(text).not.toMatch(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']node:/);
  });

  test('REQ-CONF-5: the runtime entry exposes runConformance for callers that supply vectors', async () => {
    const vectors = loadVectors().filter((v) => v.id === 'core/post-executes-once');
    const { summary, report } = await runConformance({
      target: createFixtureApp().fetch,
      vectors,
      report: 'markdown',
    });
    expect(summary.results.map((r) => r.id)).toEqual(['core/post-executes-once']);
    expect(summary.passed).toBe(1);
    expect(report).toContain('# anyonce conformance report');
  });
});
