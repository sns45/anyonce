import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('packages/stores/migrations/d1');
  return {
    test: {
      include: ['test/workers/**/*.test.ts', 'packages/stores/workers/**/*.test.ts'],
      testTimeout: 60_000,
      setupFiles: ['./test/workers/setup-d1.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
