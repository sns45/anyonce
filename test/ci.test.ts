import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

type Job = {
  steps: Array<{ uses?: string; run?: string; shell?: string; with?: Record<string, unknown> }>;
  strategy?: { matrix?: Record<string, unknown[]> };
};
const ci = parse(readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};
const runs = (job: Job) => job.steps.map((s) => s.run ?? '').join('\n');
const uses = (job: Job) => job.steps.map((s) => s.uses ?? '');

describe('ci workflow', () => {
  test('REQ-REL-4: declares the ts, vectors-validate, workers, go, services and node-compat jobs', () => {
    expect(Object.keys(ci.jobs).sort()).toEqual([
      'go',
      'node-compat',
      'services',
      'ts',
      'vectors-validate',
      'workers',
    ]);
  });

  test('REQ-REL-4: the services job starts the compose stack and proves connectivity', () => {
    const job = ci.jobs.services as Job;
    expect(runs(job)).toContain('docker compose -f test/compose.yml up -d --wait');
    expect(runs(job)).toContain('bun run services:check');
    expect(runs(job)).toContain('bun run test:services');
    expect(runs(job)).toContain('scripts/no-skips.sh');
  });

  test('REQ-REL-4: the ts job does not run the compose service tests', () => {
    expect(runs(ci.jobs.ts as Job)).not.toContain('compose.test');
  });

  test('REQ-REL-4: the ts job runs the typecheck gate', () => {
    expect(runs(ci.jobs.ts as Job)).toContain('bun run typecheck');
  });

  test('REQ-REL-4: tee pipelines use bash with pipefail', () => {
    for (const name of ['ts', 'services']) {
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

  test('REQ-REL-4: the ts job runs the toolchain doctor right after install', () => {
    const runSteps = (ci.jobs.ts as Job).steps.filter((s) => typeof s.run === 'string');
    expect(runSteps[0]?.run).toBe('bun install --frozen-lockfile');
    expect(runSteps[1]?.run).toMatch(/^(scripts\/doctor\.sh|bun run doctor)$/);
  });

  test('REQ-REL-4: every bun test job fails on skipped tests', () => {
    for (const name of ['ts', 'services']) {
      expect(runs(ci.jobs[name] as Job)).toContain('scripts/no-skips.sh');
    }
  });
});
