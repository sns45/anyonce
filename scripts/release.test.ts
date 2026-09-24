import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { readChangesets } from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';
import { parse } from 'yaml';
import { parseBunLock, prunedLockfile } from './release/lockfile';
import { checkPackedFiles, checkPackedManifest } from './release/manifest';

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
type Job = {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  defaults?: { run?: { 'working-directory'?: string } };
  steps: Step[];
};
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
  license: 'Apache-2.0',
  repository: {
    type: 'git',
    url: 'git+https://github.com/sns45/anyonce.git',
    directory: 'packages/hono',
  },
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

  test('REQ-REL-2: checkPackedManifest reports a missing license, a missing repository and a wrong repository url or directory', () => {
    const noLicense = goodManifest() as Record<string, unknown>;
    delete noLicense.license;
    expect(checkPackedManifest(noLicense, '@anyonce/hono').some((p) => p.includes('license'))).toBe(
      true,
    );
    const noRepository = goodManifest() as Record<string, unknown>;
    delete noRepository.repository;
    expect(
      checkPackedManifest(noRepository, '@anyonce/hono').some((p) => p.includes('repository')),
    ).toBe(true);
    const wrongUrl = goodManifest();
    wrongUrl.repository.url = 'git+https://github.com/someone/else.git';
    expect(
      checkPackedManifest(wrongUrl, '@anyonce/hono').some((p) => p.includes('repository.url')),
    ).toBe(true);
    const wrongDir = goodManifest();
    wrongDir.repository.directory = 'packages/core';
    expect(
      checkPackedManifest(wrongDir, '@anyonce/hono').some((p) =>
        p.includes('repository.directory'),
      ),
    ).toBe(true);
  });

  test('REQ-REL-2: every publishable source manifest declares the license and its own repository directory', () => {
    for (const dir of readdirSync(join(root, 'packages'))) {
      const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as {
        private?: boolean;
        license?: string;
        repository?: unknown;
        files?: string[];
      };
      if (pkg.private === true) continue;
      expect(pkg.license).toBe('Apache-2.0');
      expect(pkg.repository).toEqual({
        type: 'git',
        url: 'git+https://github.com/sns45/anyonce.git',
        directory: `packages/${dir}`,
      });
      expect(pkg.files).toContain('LICENSE');
    }
  });

  test('REQ-REL-2: checkPackedFiles fails a tarball without package/LICENSE', () => {
    expect(checkPackedFiles(['package/package.json', 'package/LICENSE'], '@anyonce/hono')).toEqual(
      [],
    );
    expect(
      checkPackedFiles(['package/package.json', 'package/dist/index.js'], '@anyonce/hono'),
    ).toEqual(['@anyonce/hono: the tarball has no package/LICENSE']);
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

  test('REQ-REL-2: the workspace bun.lock parses and @anyonce/core has an empty runtime closure', () => {
    const workspaceLock = parseBunLock(readFileSync(join(root, 'bun.lock'), 'utf8'));
    expect(Object.keys(workspaceLock.packages)).toContain('@changesets/cli');
    const core = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')) as {
      name: string;
    };
    expect(Object.keys(prunedLockfile(workspaceLock, core).packages)).toEqual([]);
    // Every other package's closure resolves against the lockfile (prunedLockfile throws otherwise).
    for (const dir of readdirSync(join(root, 'packages'))) {
      const manifest = JSON.parse(
        readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'),
      ) as { name: string };
      expect(() => prunedLockfile(workspaceLock, manifest)).not.toThrow();
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
    expect(wf.permissions).toEqual({ contents: 'read' });
    const job = wf.jobs.npm as Job;
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect((wf.jobs.go as Job).permissions).toBeUndefined();
    expect(job.if).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    const setupBun = job.steps.find((s) => s.uses?.startsWith('oven-sh/setup-bun@')) as Step;
    expect(setupBun.with?.['bun-version']).toBe('1.4.2');
    const script = runs(job);
    expect(script).toContain('cp LICENSE "$dir"');
    expect(script.indexOf('cp LICENSE')).toBeLessThan(script.indexOf('bun pm pack'));
    expect(script).toContain('bun scripts/release/manifest.ts dist-release/*.tgz');
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
    expect(publish.env?.DOPPLER_TOKEN).toMatch(/^\$\{\{ secrets\.DOPPLER_TOKEN \}\}$/);
    expect(publish.run).toContain('doppler run --');
    expect(publish.run).toContain('export NODE_AUTH_TOKEN="$NPM_TOKEN"');
    expect(script.indexOf('forgeseal verify')).toBeLessThan(script.indexOf('npm publish'));
    const setupNode = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@')) as Step;
    expect(setupNode.with?.['registry-url']).toBe('https://registry.npmjs.org');
    const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@')) as Step;
    expect(upload.if).toBe('success() || failure()');
    expect(upload.with?.['if-no-files-found']).toBe('warn');
  });

  test('REQ-REL-2: release.yml sources the npm token from Doppler, never from an NPM_TOKEN secret', () => {
    const text = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(text).not.toContain('secrets.NPM_TOKEN');
    expect(text).not.toContain('NPM_TOKEN }}');
    const job = readWorkflow().jobs.npm as Job;
    const dopplerInstall = job.steps.find((s) => s.uses?.startsWith('dopplerhq/cli-action@')) as
      | Step
      | undefined;
    expect(dopplerInstall).toBeDefined();
    const publish = job.steps.find((s) => (s.run ?? '').includes('npm publish')) as Step;
    expect(publish.run).toContain('doppler run --');
    const authCheck = job.steps.find((s) => (s.run ?? '').includes('npm whoami')) as Step;
    expect(authCheck.run).toContain('doppler run --');
    expect(authCheck.env?.DOPPLER_TOKEN).toMatch(/^\$\{\{ secrets\.DOPPLER_TOKEN \}\}$/);
    expect(authCheck.if).toBe(publish.if);
    expect(job.steps.indexOf(dopplerInstall as Step)).toBeLessThan(job.steps.indexOf(authCheck));
    expect(job.steps.indexOf(authCheck)).toBeLessThan(job.steps.indexOf(publish));
  });

  test('REQ-REL-2: release.yml publishes only from a v* tag ref, and only a version equal to the tag', () => {
    const job = readWorkflow().jobs.npm as Job;
    const publish = job.steps.find((s) => (s.run ?? '').includes('npm publish')) as Step;
    // A dispatch with publish true from a branch must not publish: the tag ref is required for both events.
    expect(publish.if).toBe(
      "startsWith(github.ref, 'refs/tags/v') && (github.event_name == 'push' || inputs.publish)",
    );
    const versionCheck = job.steps.find((s) => (s.run ?? '').includes('GITHUB_REF_NAME#v')) as Step;
    expect(versionCheck.if).toBe(publish.if);
    expect(versionCheck.run).toContain('dist-release/*.tgz');
    expect(versionCheck.run).toContain('exit 1');
    expect(job.steps.indexOf(versionCheck)).toBeLessThan(job.steps.indexOf(publish));
  });

  test('REQ-REL-2: release.yml verifies each keyless bundle with cosign against the workflow identity', () => {
    const job = readWorkflow().jobs.npm as Job;
    const installers = job.steps.filter((s) => s.uses?.startsWith('sigstore/cosign-installer@'));
    expect(installers.map((s) => s.uses)).toEqual(['sigstore/cosign-installer@v4.1.2']);
    const script = runs(job);
    const cosign = /cosign verify-blob --bundle "([^"]+)"[^\n]*/g;
    const lines = [...script.matchAll(cosign)].map((m) => m[0]);
    expect(lines.map((l) => /--bundle "([^"]+)"/.exec(l)?.[1]).sort()).toEqual(
      ['$base.cdx.json.sigstore.json', '$tgz.sigstore.json'].sort(),
    );
    for (const line of lines) {
      expect(line).toContain(
        String.raw`--certificate-identity-regexp '^https://github\.com/sns45/anyonce/\.github/workflows/release\.yml@'`,
      );
      expect(line).toContain(
        '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
      );
    }
    expect(script.indexOf('cosign verify-blob')).toBeLessThan(script.indexOf('npm publish'));
  });

  test('REQ-REL-2: release.yml publishes only a commit on main, behind the npm-release environment', () => {
    const job = readWorkflow().jobs.npm as Job;
    expect(job.environment).toBe('npm-release');
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@')) as Step;
    expect(checkout.with?.['fetch-depth']).toBe(0);
    const publish = job.steps.find((s) => (s.run ?? '').includes('npm publish')) as Step;
    const onMain = job.steps.find((s) => (s.run ?? '').includes('git merge-base')) as Step;
    expect(onMain.if).toBe(publish.if);
    expect(onMain.run).toContain(
      'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
    );
    expect(onMain.run).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(onMain.run).toContain('exit 1');
    expect(job.steps.indexOf(onMain)).toBeLessThan(job.steps.indexOf(publish));
    // Repository settings are the owner's job; the workflow says so next to the environment.
    const text = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(text).toMatch(/required reviewers on the npm-release environment/);
  });

  test('REQ-REL-2: release.yml publishes @anyonce/core first and skips a version already on npm', () => {
    const job = readWorkflow().jobs.npm as Job;
    const publish = (job.steps.find((s) => (s.run ?? '').includes('npm publish')) as Step)
      .run as string;
    const coreLoop = publish.indexOf('for tgz in dist-release/anyonce-core-*.tgz');
    const restLoop = publish.indexOf('for tgz in dist-release/*.tgz');
    expect(coreLoop).toBeGreaterThan(-1);
    expect(restLoop).toBeGreaterThan(coreLoop);
    expect(publish).toContain('dist-release/anyonce-core-*) continue');
    expect(publish).toContain('npm view "$name@$version" version');
    expect(publish.indexOf('npm view')).toBeLessThan(publish.indexOf('npm publish'));
    expect(publish).toContain('return 0');
  });

  test('REQ-CONF-7: release.yml loads the packed conformance vectors outside the checkout before publishing', () => {
    const job = readWorkflow().jobs.npm as Job;
    const check = job.steps.find((s) =>
      (s.run ?? '').includes('scripts/release/packed-vectors.ts'),
    ) as Step;
    expect(check.run).toBe(
      'bun scripts/release/packed-vectors.ts dist-release/anyonce-conformance-*.tgz',
    );
    expect(check.if).toBeUndefined();
    const pack = job.steps.find((s) => (s.run ?? '').includes('bun pm pack')) as Step;
    const publish = job.steps.find((s) => (s.run ?? '').includes('npm publish')) as Step;
    expect(job.steps.indexOf(pack)).toBeLessThan(job.steps.indexOf(check));
    expect(job.steps.indexOf(check)).toBeLessThan(job.steps.indexOf(publish));
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
