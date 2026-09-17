import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(import.meta.dir, '../dist');

describe('build output', () => {
  test('NFR-3: tsup emits esm, cjs and d.ts for both entries', async () => {
    const build = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: join(import.meta.dir, '..'),
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(build.exitCode).toBe(0);
    for (const file of [
      'index.js',
      'index.cjs',
      'index.d.ts',
      'testing/index.js',
      'testing/index.cjs',
      'testing/index.d.ts',
    ]) {
      expect(existsSync(join(dist, file))).toBe(true);
    }
    const esm = (await import(join(dist, 'index.js'))) as {
      execute?: unknown;
      MemoryStore?: unknown;
    };
    expect(typeof esm.execute).toBe('function');
    expect(typeof esm.MemoryStore).toBe('function');
    const testing = (await import(join(dist, 'testing/index.js'))) as {
      storeContractSuite?: unknown;
    };
    expect(typeof testing.storeContractSuite).toBe('function');
  }, 60_000);
});
