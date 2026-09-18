import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

type Job = {
  steps: Array<{
    name?: string;
    uses?: string;
    run?: string;
    shell?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
    'working-directory'?: string;
  }>;
  strategy?: { matrix?: Record<string, unknown[]> };
};
const ci = parse(readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};
const runs = (job: Job) => job.steps.map((s) => s.run ?? '').join('\n');
const uses = (job: Job) => job.steps.map((s) => s.uses ?? '');

describe('ci workflow', () => {
  test('REQ-REL-4: declares the ts, vectors-validate, workers, go, services, node-compat and deno jobs', () => {
    expect(Object.keys(ci.jobs).sort()).toEqual([
      'deno',
      'go',
      'node-compat',
      'services',
      'ts',
      'vectors-validate',
      'workers',
    ]);
  });

  test('REQ-REL-4: the runtime matrix jobs build first and run the node and deno suites', () => {
    expect(runs(ci.jobs.workers as Job)).toContain('bun run build');
    expect(runs(ci.jobs.workers as Job).indexOf('bun run build')).toBeLessThan(
      runs(ci.jobs.workers as Job).indexOf('bun run test:workers'),
    );
    expect(runs(ci.jobs['node-compat'] as Job)).toContain('bun run test:node');
    expect(runs(ci.jobs.deno as Job)).toContain('bun run test:deno');
    expect(uses(ci.jobs.deno as Job)).toContain('denoland/setup-deno@v2');
  });

  test('REQ-REL-4: the services job starts the compose stack and proves connectivity', () => {
    const job = ci.jobs.services as Job;
    expect(runs(job)).toContain('docker compose -f test/compose.yml up -d --wait');
    expect(runs(job)).toContain('bun run services:check');
    expect(runs(job)).toContain('bun run test:services');
    expect(runs(job)).toContain('scripts/no-skips.sh');
  });

  test('REQ-REL-4: the services job runs the Go store tests with services required', () => {
    const job = ci.jobs.services as Job;
    expect(uses(job).some((u) => u.startsWith('actions/setup-go@'))).toBe(true);
    const step = job.steps.find((s) => s.run?.includes('go test -race -count=1 ./store/...'));
    expect(step).toBeTruthy();
    expect(step?.env?.ANYONCE_REQUIRE_SERVICES).toBe('1');
    expect(step?.['working-directory']).toBe('go');
  });

  test('REQ-REL-4: the ts job does not run the compose service tests', () => {
    expect(runs(ci.jobs.ts as Job)).not.toContain('compose.test');
  });

  test('REQ-REL-4: the ts job runs the typecheck gate', () => {
    expect(runs(ci.jobs.ts as Job)).toContain('bun run typecheck');
  });

  test('REQ-REL-4: the ts job runs the size budget and the coverage gate', () => {
    expect(runs(ci.jobs.ts as Job)).toContain('bun run size');
    expect(runs(ci.jobs.ts as Job)).toContain('bun run test:coverage');
  });

  test('REQ-REL-4: tee pipelines use bash with pipefail', () => {
    for (const name of ['ts', 'services', 'workers']) {
      const job = ci.jobs[name] as Job;
      for (const step of job.steps) {
        if (step.run?.includes('| tee')) {
          expect(step.shell).toBe('bash');
        }
      }
    }
  });

  test('REQ-REL-4: node-compat runs the built output on Node 22 and go tests stable and oldstable', () => {
    const node = ci.jobs['node-compat'] as Job;
    expect(uses(node).some((u) => u.startsWith('actions/setup-node@'))).toBe(true);
    expect(JSON.stringify(node.steps)).toContain('"node-version":22');
    const go = ci.jobs.go as Job;
    expect(go.strategy?.matrix?.go).toEqual(['stable', 'oldstable']);
    expect(runs(go)).toContain('go test -race ./...');
    expect(uses(go).some((u) => u.startsWith('golangci/golangci-lint-action@'))).toBe(true);
    const golangci = go.steps.find((s) => s.uses?.startsWith('golangci/golangci-lint-action@'));
    expect(golangci?.with?.version).toBe('v2.13.2');
  });

  test('REQ-REL-4: the go job builds with cgo disabled', () => {
    const job = ci.jobs.go as Job;
    const steps = job.steps.map((s) => s.run ?? '');
    const cgoAt = steps.indexOf('CGO_ENABLED=0 go build ./...');
    expect(cgoAt).toBeGreaterThan(-1);
    expect(steps.indexOf('go vet ./...')).toBeGreaterThan(cgoAt);
  });

  test('REQ-REL-4: the go job runs the engine coverage gate', () => {
    expect(runs(ci.jobs.go as Job)).toContain('go-engine-coverage.sh');
  });

  test('REQ-REL-4: the go job runs the nested anyhook interop module', () => {
    const steps = ci.jobs.go.steps as Array<{ run?: string; 'working-directory'?: string }>;
    const step = steps.find((s) => s['working-directory'] === 'go/webhookmw/interop');
    expect(step?.run).toBe('go test -race ./...');
  });

  test('REQ-REL-4: the ts job runs the toolchain doctor right after install', () => {
    const runSteps = (ci.jobs.ts as Job).steps.filter((s) => typeof s.run === 'string');
    expect(runSteps[0]?.run).toBe('bun install --frozen-lockfile');
    expect(runSteps[1]?.run).toMatch(/^(scripts\/doctor\.sh|bun run doctor)$/);
  });

  test('REQ-REL-4: ts job runs the dash and key-log gates', () => {
    const job = ci.jobs.ts as Job;
    const names = job.steps.map((s) => s.name ?? '');
    expect(names).toContain('dash gate');
    expect(names).toContain('key-log gate');
    const text = runs(job);
    expect(text).toContain('rg -n "[\\x{2013}\\x{2014}]"');
    expect(text).toContain("--glob '!docs/reference/**'");
    expect(text).toContain("rg -n 'console\\.(log|info|warn|error)\\(.*key' packages go");
    for (const step of job.steps) {
      if (step.name === 'dash gate' || step.name === 'key-log gate') {
        expect(step.shell).toBe('bash');
        expect(step.run?.trim().startsWith('!')).toBe(true);
      }
    }
    const lintAt = job.steps.findIndex((s) => s.run === 'bun run lint');
    expect(names.indexOf('dash gate')).toBeGreaterThan(lintAt);
    expect(names.indexOf('key-log gate')).toBeGreaterThan(lintAt);
  });

  test('REQ-REL-4: node-compat requires every CJS entry', () => {
    const text = runs(ci.jobs['node-compat'] as Job);
    for (const entry of [
      '@anyonce/core',
      '@anyonce/core/testing',
      '@anyonce/core/http',
      '@anyonce/hono',
      '@anyonce/conformance/runtime',
      '@anyonce/webhooks',
    ]) {
      expect(text).toContain(`require('${entry}')`);
    }
  });

  test('REQ-REL-4: the ts job builds before it typechecks because packages resolve each other through dist', () => {
    const steps = (ci.jobs.ts as Job).steps.map((s) => s.run ?? '');
    const buildAt = steps.indexOf('bun run build');
    const typecheckAt = steps.indexOf('bun run typecheck');
    expect(buildAt).toBeGreaterThan(-1);
    expect(typecheckAt).toBeGreaterThan(buildAt);
  });

  test('REQ-REL-4: no root test filter matches a service-backed suite, which only test:services may run', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts.test ?? '';
    const filters = script.replace('bun test ', '').split(/\s+/).filter(Boolean);
    expect(filters.length).toBeGreaterThan(0);
    const serviceDir = 'packages/stores/services';
    const suites = readdirSync(join(import.meta.dir, '..', serviceDir))
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `${serviceDir}/${name}`);
    expect(suites.length).toBeGreaterThan(0);
    // bun test treats a positional argument as a path substring, so a bare "conformance" would
    // also collect packages/stores/services/dynamodb.conformance.test.ts.
    const matched = suites.flatMap((suite) =>
      filters.filter((filter) => suite.includes(filter)).map((filter) => `${suite} <- ${filter}`),
    );
    expect(matched).toEqual([]);
  });

  test('REQ-REL-4: the services job builds before it runs the store suites, which import @anyonce/core through dist', () => {
    const steps = (ci.jobs.services as Job).steps.map((s) => s.run ?? '');
    const buildAt = steps.indexOf('bun run build');
    const testAt = steps.findIndex((s) => s.includes('bun run test:services'));
    expect(buildAt).toBeGreaterThan(-1);
    expect(testAt).toBeGreaterThan(buildAt);
  });

  test('REQ-REL-4: every test job fails on skipped tests, the workers job included', () => {
    for (const name of ['ts', 'services', 'workers']) {
      expect(runs(ci.jobs[name] as Job)).toContain('scripts/no-skips.sh');
    }
    const workers = ci.jobs.workers as Job;
    expect(runs(workers)).toContain('bun run test:workers 2>&1 | tee workers.log');
    expect(runs(workers)).toContain('scripts/no-skips.sh workers.log');
    expect(runs(workers).indexOf('tee workers.log')).toBeLessThan(
      runs(workers).indexOf('scripts/no-skips.sh workers.log'),
    );
  });
});
