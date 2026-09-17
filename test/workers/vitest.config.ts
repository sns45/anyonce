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
          // One worker, so the test files run one at a time. What was observed: the D1 REQ-STORE-8 race test
          // (50 parallel begins over 20 iterations) failed once in CI with "Network connection lost" while
          // four workerd runtimes ran the workers files in parallel. The pool ignores vitest's own
          // fileParallelism and maxWorkers, so this option is the only way to ask for one runtime. With one
          // runtime the failure has not recurred, at a cost of about 12 seconds. isolatedStorage stays on, so
          // every test still gets its own storage frame and no assertion changes. The likely mechanism is the
          // per-file storage frame pop, which calls workerd's abortAllDurableObjects, racing an in-flight D1
          // statement inside the same file; one runtime does not remove that race, it lowers the load that
          // made it show.
          singleWorker: true,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
