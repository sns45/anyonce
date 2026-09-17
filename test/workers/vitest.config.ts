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
          // One worker, so the test files run one at a time. isolatedStorage (on by default) pushes and
          // pops a storage frame around every test, and each of those calls workerd's abortAllDurableObjects,
          // which is global to the miniflare instance rather than scoped to the file. With files in parallel,
          // one file's frame push aborts another file's in-flight Durable Object work, which surfaces as
          // "Network connection lost" in whichever test is busiest at that moment: on CI that was the D1
          // REQ-STORE-8 race, 50 parallel begins over 20 iterations. Serializing keeps per-test isolation and
          // every assertion intact and costs about 12 seconds. The pool ignores vitest's own fileParallelism
          // and maxWorkers, so this is the knob that does it.
          singleWorker: true,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
