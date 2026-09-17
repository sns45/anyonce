import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

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
});
