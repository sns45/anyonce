import { defineConfig } from 'vitest/config';

// Coverage-only harness (Q10). Tests import from bun:test; this alias runs the same files under vitest.
export default defineConfig({
  resolve: { alias: { 'bun:test': 'vitest' } },
  test: {
    // Only the files whose sources carry a branch threshold. Other core tests use Bun globals and stay on bun test.
    include: ['test/engine.test.ts', 'test/key.test.ts', 'test/sfstring.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/engine.ts', 'src/key.ts', 'src/sfstring.ts'],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
      reporter: ['text'],
    },
  },
});
