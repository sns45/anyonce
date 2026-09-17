import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CORE_BUDGET_BYTES, measureBundle } from '../../../scripts/size';

describe('bundle size', () => {
  test('REQ-REL-5: the core root entry is under 8 KB minified plus gzip', async () => {
    const { gzip, minified } = await measureBundle(join(import.meta.dir, '../src/index.ts'));
    expect(minified).toBeGreaterThan(0);
    expect(gzip).toBeLessThan(CORE_BUDGET_BYTES);
  });
});
