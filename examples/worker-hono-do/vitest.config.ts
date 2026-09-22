import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Runs from the repository root (bun run test:examples:workers) or from this directory (bun run test). The
// root bun suite never collects this directory: bun run test:examples passes --path-ignore-patterns for it.
export default defineWorkersConfig({
  root,
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    poolOptions: {
      workers: {
        // One workerd runtime, as test/workers/vitest.config.ts runs the Durable Objects suites.
        singleWorker: true,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
