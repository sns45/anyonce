import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    dynamodb: 'src/dynamodb.ts',
    redis: 'src/redis.ts',
    postgres: 'src/postgres.ts',
    d1: 'src/d1.ts',
    'durable-objects': 'src/durable-objects.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  external: ['cloudflare:workers'],
});
