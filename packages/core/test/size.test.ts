import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CORE_BUDGET_BYTES, HTTP_BUDGET_BYTES, measureBundle } from '../../../scripts/size';

const root = join(import.meta.dir, '../../..');

describe('bundle size', () => {
  test('REQ-REL-5: the core root entry is under 8 KB minified plus gzip', async () => {
    const { gzip, minified } = await measureBundle(join(import.meta.dir, '../src/index.ts'));
    expect(minified).toBeGreaterThan(0);
    expect(gzip).toBeLessThan(CORE_BUDGET_BYTES);
  });

  test('REQ-REL-5: the http subpath entry is under 16384 bytes gzip', async () => {
    const { gzip } = await measureBundle(join(root, 'packages/core/src/http/index.ts'));
    expect(gzip).toBeLessThan(HTTP_BUDGET_BYTES + 1);
    expect(HTTP_BUDGET_BYTES).toBe(16384);
  });
});
