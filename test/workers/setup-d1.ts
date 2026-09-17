// Type only, and from src rather than the package entry: the workers tests construct the store from
// src, and the private field on the class makes the src and dist declarations two distinct types.

import { applyD1Migrations, env } from 'cloudflare:test';
import type { IdempotencyObject } from '../../packages/stores/src/durable-objects';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    IDEMPOTENCY: DurableObjectNamespace<IdempotencyObject>;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
