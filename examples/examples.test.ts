import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { EXAMPLES_DIR, goExamples } from '../test/examples';

/** REQ-DOC-7's list, in the order requirements.md 4.8 names them. */
const NAMED = [
  'worker-hono-do',
  'lambda-fetch-dynamodb',
  'go-net-http-postgres',
  'anyq-consumer-ts',
  'anyq-consumer-go',
  'webhook-receiver-standard-webhooks',
];

/** The one example bun test does not run: it needs the Workers runtime, so vitest-pool-workers runs it. */
const WORKERS_EXAMPLE = 'worker-hono-do';

type Step = {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
};

const ci = parse(readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};
const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  workspaces: string[];
};

const read = (...path: string[]) => readFileSync(join(EXAMPLES_DIR, ...path), 'utf8');

describe('examples inventory', () => {
  test('REQ-DOC-7: examples holds exactly the six named examples, each with a README and a smoke test', () => {
    const dirs = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(dirs.sort()).toEqual([...NAMED].sort());

    const go = goExamples();
    expect(go.sort()).toEqual(['anyq-consumer-go', 'go-net-http-postgres']);
    for (const name of NAMED) {
      expect(existsSync(join(EXAMPLES_DIR, name, 'README.md')), `${name} README.md`).toBe(true);
      const smoke = go.includes(name) ? 'smoke_test.go' : join('test', 'smoke.test.ts');
      expect(existsSync(join(EXAMPLES_DIR, name, smoke)), `${name} ${smoke}`).toBe(true);
      // Every smoke test proves REQ-DOC-7 by name, so the requirement check sees each example.
      expect(read(name, smoke), name).toMatch(/REQ-DOC-7: |TestREQ_DOC_7_/);
      if (!go.includes(name)) {
        expect(pkg.workspaces, name).toContain(`examples/${name}`);
      }
    }
  });

  test('REQ-DOC-7: the examples CI job runs every example', () => {
    const steps = ci.jobs.examples?.steps ?? [];
    const runs = steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('bun run test:examples 2>&1');
    expect(runs).toContain('bun run test:examples:workers 2>&1');

    // bun test runs every TypeScript example but the Workers one, and the vitest config runs that one.
    expect(pkg.scripts['test:examples']).toBe(
      `bun test examples --path-ignore-patterns='examples/${WORKERS_EXAMPLE}/**'`,
    );
    expect(pkg.scripts['test:examples:workers']).toContain(`examples/${WORKERS_EXAMPLE}/`);

    const go = goExamples();
    for (const name of go) {
      const run = steps.find((s) => s['working-directory'] === `examples/${name}`)?.run ?? '';
      expect(run, name).toContain('go vet ./...');
      expect(run, name).toContain('go test -race -count=1 ./...');
      const lint = steps.find(
        (s) =>
          s.uses?.startsWith('golangci/golangci-lint-action@') &&
          s.with?.['working-directory'] === `examples/${name}`,
      );
      expect(lint, `${name} lint`).toBeTruthy();
    }
  });

  test('REQ-Q-8: both queue examples show the door and the strategy wired together', () => {
    for (const file of [
      ['anyq-consumer-ts', 'README.md'],
      ['anyq-consumer-ts', 'src', 'consumer.ts'],
    ]) {
      const text = read(...file);
      expect(text, file.join('/')).toContain('idempotent(');
      expect(text, file.join('/')).toContain('idempotencyStrategy(');
    }
    for (const file of [
      ['anyq-consumer-go', 'README.md'],
      ['anyq-consumer-go', 'consumer.go'],
    ]) {
      const text = read(...file);
      expect(text, file.join('/')).toContain('anyqmw.Wrap(');
      expect(text, file.join('/')).toContain('anyqmw.Strategy(');
    }
  });
});
