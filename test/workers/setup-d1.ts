import { applyD1Migrations, env } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    IDEMPOTENCY: DurableObjectNamespace;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
