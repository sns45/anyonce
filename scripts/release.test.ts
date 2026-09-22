import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { readChangesets } from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';
import { parse } from 'yaml';
import { parseBunLock, prunedLockfile } from './release/lockfile';
import { checkPackedManifest } from './release/manifest';

const root = join(import.meta.dir, '..');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'working-directory'?: string;
  if?: string;
};
type Job = { if?: string; defaults?: { run?: { 'working-directory'?: string } }; steps: Step[] };
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const readWorkflow = (): Workflow =>
  parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')) as Workflow;
const runs = (job: Job) => job.steps.map((s) => s.run ?? '').join('\n');

/** Every workspace package that npm would publish: `@anyonce/*` and not private. */
function publishedPackages(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(join(root, 'packages'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as {
      name: string;
      private?: boolean;
    };
    if (pkg.private !== true && pkg.name.startsWith('@anyonce/')) out.push(pkg.name);
  }
  return out.sort();
}

const globMatches = (pattern: string, name: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(
    name,
  );

const goodManifest = () => ({
  name: '@anyonce/hono',
  version: '0.1.0',
  type: 'module',
  sideEffects: false,
  main: './dist/index.cjs',
  module: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' },
    './migrations/*': './migrations/*',
  },
  peerDependencies: { '@anyonce/core': '^0.1.0', hono: '>=4.8.0' },
});

describe('release: changesets', () => {
  test('REQ-REL-1: changesets uses one fixed group for every @anyonce package', () => {
    const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8')) as {
      fixed: string[][];
    };
    expect(config.fixed).toEqual([['@anyonce/*']]);
    const published = publishedPackages();
    expect(published.length).toBeGreaterThanOrEqual(6);
    for (const name of published) expect(globMatches('@anyonce/*', name)).toBe(true);
  });

  test('REQ-REL-1: the pending changesets release every published package at 0.1.0', async () => {
    const packages = await getPackages(root);
    const parsed = await readConfig(root, packages);
    if (parsed.config === undefined)
      throw new Error(`changeset config: ${parsed.errors.join('; ')}`);
    const changesets = await readChangesets(root);
    const plan = assembleReleasePlan(changesets, packages, parsed.config, undefined);
    const versions = Object.fromEntries(plan.releases.map((r) => [r.name, r.newVersion]));
    for (const name of publishedPackages()) expect(versions[name]).toBe('0.1.0');
  });
});

describe('release: packed manifests', () => {
  test('NFR-3: checkPackedManifest accepts a manifest with exports, types, ESM and CJS entries and sideEffects false', () => {
    expect(checkPackedManifest(goodManifest(), '@anyonce/hono')).toEqual([]);
    const { main: _m, module: _mod, types: _t, ...subpathsOnly } = goodManifest();
    expect(checkPackedManifest(subpathsOnly, '@anyonce/hono')).toEqual([]);
  });

  test('NFR-3: checkPackedManifest reports a workspace: specifier, a missing types entry and sideEffects not false', () => {
    const bad = goodManifest() as Record<string, unknown>;
    bad.peerDependencies = { '@anyonce/core': 'workspace:^' };
    bad.exports = { '.': { import: './dist/index.js', require: './dist/index.cjs' } };
    bad.sideEffects = true;
    const problems = checkPackedManifest(bad, '@anyonce/hono');
    expect(problems.some((p) => p.includes('workspace:'))).toBe(true);
    expect(problems.some((p) => p.includes('types'))).toBe(true);
    expect(problems.some((p) => p.includes('sideEffects'))).toBe(true);
  });

  test('NFR-3: checkPackedManifest reports a wrong name, a missing exports map and a missing CJS entry', () => {
    expect(checkPackedManifest(null, '@anyonce/hono')).not.toEqual([]);
    const noExports = goodManifest() as Record<string, unknown>;
    delete noExports.exports;
    expect(checkPackedManifest(noExports, '@anyonce/hono').some((p) => p.includes('exports'))).toBe(
      true,
    );
    const noCjs = goodManifest() as Record<string, unknown>;
    noCjs.exports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
    expect(checkPackedManifest(noCjs, '@anyonce/hono').some((p) => p.includes('require'))).toBe(
      true,
    );
    expect(
      checkPackedManifest(goodManifest(), '@anyonce/core').some((p) => p.includes('name')),
    ).toBe(true);
  });

  test('NFR-3: the source manifests declare no workspace:* peer (bun pm pack would pin it exactly)', () => {
    for (const dir of readdirSync(join(root, 'packages'))) {
      const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as {
        peerDependencies?: Record<string, string>;
      };
      for (const [dep, range] of Object.entries(pkg.peerDependencies ?? {})) {
        if (dep === '@anyonce/core') expect(`${dir}: ${range}`).toBe(`${dir}: workspace:^`);
      }
    }
  });
});

describe('release: SBOM lockfile', () => {
  const lock = {
    lockfileVersion: 1,
    workspaces: { '': { name: 'root' } },
    packages: {
      a: ['a@1.0.0', '', { dependencies: { b: '^2.0.0' } }, 'sha512-a'],
      b: ['b@2.0.0', '', {}, 'sha512-b'],
      'a/c': ['c@3.0.0', '', {}, 'sha512-c'],
      c: ['c@1.0.0', '', {}, 'sha512-c1'],
      unrelated: ['unrelated@9.0.0', '', {}, 'sha512-u'],
    },
  };

  test('REQ-REL-2: the SBOM lockfile keeps only the runtime dependency closure of the packed package', () => {
    const out = prunedLockfile(lock, {
      name: '@anyonce/x',
      dependencies: { a: '^1.0.0' },
      peerDependencies: { c: '*' },
    });
    expect(Object.keys(out.packages).sort()).toEqual(['a', 'b']);
    const nested = prunedLockfile(
      {
        ...lock,
        packages: { ...lock.packages, a: ['a@1.0.0', '', { dependencies: { c: '^3' } }, 'x'] },
      },
      { name: '@anyonce/x', dependencies: { a: '^1.0.0' } },
    );
    expect(Object.keys(nested.packages).sort()).toEqual(['a', 'a/c']);
  });

  test('REQ-REL-2: a package with no runtime dependencies gets an SBOM lockfile with no packages', () => {
    const out = prunedLockfile(lock, { name: '@anyonce/core', devDependencies: { a: '^1.0.0' } });
    expect(out.packages).toEqual({});
    expect(out.workspaces).toEqual({ '': { name: '@anyonce/core' } });
  });

  test('REQ-REL-2: the workspace bun.lock parses and every published package has an empty runtime closure', () => {
    const workspaceLock = parseBunLock(readFileSync(join(root, 'bun.lock'), 'utf8'));
    expect(Object.keys(workspaceLock.packages)).toContain('@changesets/cli');
    for (const dir of readdirSync(join(root, 'packages'))) {
      const manifest = JSON.parse(
        readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'),
      ) as {
        name: string;
      };
      expect(Object.keys(prunedLockfile(workspaceLock, manifest).packages)).toEqual([]);
    }
  });
});

describe('release: workflow', () => {
  test('REQ-REL-2: release.yml runs only on a tag or a manual dispatch', () => {
    const wf = readWorkflow();
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    const push = wf.on.push as Record<string, unknown>;
    expect(Object.keys(push)).toEqual(['tags']);
    expect(push.tags).toEqual(['v*', 'go/v*']);
    expect(push.branches).toBeUndefined();
    expect(wf.on.pull_request).toBeUndefined();
    const dispatch = wf.on.workflow_dispatch as {
      inputs: { publish: { type: string; default: boolean } };
    };
    expect(dispatch.inputs.publish.type).toBe('boolean');
    expect(dispatch.inputs.publish.default).toBe(false);
  });

  test('REQ-REL-2: release.yml publishes packed tarballs with provenance and signs them with forgeseal', () => {
    const wf = readWorkflow();
    expect(wf.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    const job = wf.jobs.npm as Job;
    expect(job.if).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    const script = runs(job);
    expect(script).toContain('bun install --frozen-lockfile');
    expect(script).toContain('bun pm pack --destination');
    expect(script).toContain('go install github.com/sns45/forgeseal/cmd/forgeseal@v0.5.1');
    expect(script).toContain('forgeseal sbom');
    expect(script).toMatch(/forgeseal sign --keyed=false/);
    expect(script).toContain('forgeseal verify');
    expect(script.indexOf('bun pm pack')).toBeLessThan(script.indexOf('forgeseal sign'));
    const publish = job.steps.find((s) => (s.run ?? '').includes('npm publish')) as Step;
    expect(publish.run).toContain('--provenance');
    expect(publish.run).toContain('--access public');
    expect(publish.run).toContain('dist-release/*.tgz');
    expect(publish.if).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(publish.if).toContain('inputs.publish');
    expect(publish.env?.NODE_AUTH_TOKEN).toMatch(/^\$\{\{ secrets\.NPM_TOKEN \}\}$/);
    expect(script.indexOf('forgeseal verify')).toBeLessThan(script.indexOf('npm publish'));
    const setupNode = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@')) as Step;
    expect(setupNode.with?.['registry-url']).toBe('https://registry.npmjs.org');
    expect(job.steps.some((s) => s.uses?.startsWith('actions/upload-artifact@'))).toBe(true);
  });

  test('REQ-REL-2: release.yml never publishes through changesets and never signs the dry run way', () => {
    const text = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(text).not.toContain('changeset publish');
    expect(text).not.toContain('--ca-key');
  });

  test('REQ-REL-3: release.yml verifies the Go module on a go/v tag', () => {
    const wf = readWorkflow();
    const job = wf.jobs.go as Job;
    expect(job.if).toContain("startsWith(github.ref, 'refs/tags/go/v')");
    expect(job.defaults?.run?.['working-directory']).toBe('go');
    const script = runs(job);
    expect(script).toContain('go mod tidy -diff');
    expect(script).toContain('go vet ./...');
    expect(script).toContain('go test -race ./...');
    const lint = job.steps.find((s) =>
      s.uses?.startsWith('golangci/golangci-lint-action@v7'),
    ) as Step;
    expect(lint.with?.version).toBe('v2.13.2');
    expect(lint.with?.['working-directory']).toBe('go');
  });
});
