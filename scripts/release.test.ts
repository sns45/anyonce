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
  needs?: string | string[];
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

  test('REQ-REL-1: every published package is at, or is released by the pending changesets to, one version from 0.1.0 up', async () => {
    const packages = await getPackages(root);
    const parsed = await readConfig(root, packages);
    if (parsed.config === undefined)
      throw new Error(`changeset config: ${parsed.errors.join('; ')}`);
    const changesets = await readChangesets(root);
    const plan = assembleReleasePlan(changesets, packages, parsed.config, undefined);
    const planned = Object.fromEntries(plan.releases.map((r) => [r.name, r.newVersion]));
    const current = Object.fromEntries(
      packages.packages.map((p) => [p.packageJson.name, p.packageJson.version]),
    );
    const versions = publishedPackages().map((name) => planned[name] ?? current[name]);
    // The fixed group moves every package together, and the first release is 0.1.0.
    expect(new Set(versions).size).toBe(1);
    const [major, minor] = (versions[0] ?? '0.0.0').split('.').map(Number);
    expect((major ?? 0) > 0 || (minor ?? 0) >= 1).toBe(true);
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
    expect(
      checkPackedFiles(
        ['package/package.json', 'package/LICENSE', 'package/README.md'],
        '@anyonce/hono',
      ),
    ).toEqual([]);
    expect(
      checkPackedFiles(
        ['package/package.json', 'package/dist/index.js', 'package/README.md'],
        '@anyonce/hono',
      ),
    ).toEqual(['@anyonce/hono: the tarball has no package/LICENSE']);
  });

  test('REQ-REL-2: checkPackedFiles fails a tarball without a README', () => {
    expect(
      checkPackedFiles(
        ['package/package.json', 'package/LICENSE', 'package/README.md'],
        '@anyonce/hono',
      ),
    ).toEqual([]);
    // npm accepts README, README.md or readme.txt case-insensitively; the check matches the same way.
    expect(
      checkPackedFiles(
        ['package/package.json', 'package/LICENSE', 'package/Readme'],
        '@anyonce/hono',
      ),
    ).toEqual([]);
    expect(checkPackedFiles(['package/package.json', 'package/LICENSE'], '@anyonce/hono')).toEqual([
      '@anyonce/hono: the tarball has no README',
    ]);
    expect(
      checkPackedFiles(['package/package.json', 'package/dist/index.js'], '@anyonce/hono'),
    ).toEqual([
      '@anyonce/hono: the tarball has no package/LICENSE',
      '@anyonce/hono: the tarball has no README',
    ]);
  });

  test('NFR-3: every published package ships a source README.md, and npm packs it without a files entry', () => {
    for (const dir of readdirSync(join(root, 'packages'))) {
      const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as {
        private?: boolean;
        files?: string[];
      };
      if (pkg.private === true) continue;
      const readme = readFileSync(join(root, 'packages', dir, 'README.md'), 'utf8');
      expect(readme.length).toBeGreaterThan(0);
      // README.md is not listed in "files": npm and bun pm pack always include it regardless.
      expect(pkg.files ?? []).not.toContain('README.md');
    }
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

  test('REQ-REL-2: release.yml splits npm into a pack job without an environment and a publish job behind npm-release', () => {
    const wf = readWorkflow();
    expect(Object.keys(wf.jobs).sort()).toEqual(['go', 'pack', 'publish']);
    expect(wf.permissions).toEqual({ contents: 'read' });
    const pack = wf.jobs.pack as Job;
    const publish = wf.jobs.publish as Job;
    // A dispatch from main must run pack: the environment only admits v* tags and needs a reviewer.
    expect(pack.environment).toBeUndefined();
    expect(pack.needs).toBeUndefined();
    expect(pack.if).toBe(
      "startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'",
    );
    expect(pack.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(publish.environment).toBe('npm-release');
    expect(publish.needs).toBe('pack');
    // A dispatch with publish true from a branch must not publish: the tag ref is required for both events.
    expect(publish.if).toBe(
      "startsWith(github.ref, 'refs/tags/v') && (github.event_name == 'push' || inputs.publish)",
    );
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect((wf.jobs.go as Job).permissions).toBeUndefined();
    expect((wf.jobs.go as Job).environment).toBeUndefined();
    // Repository settings are the owner's job; the workflow says so next to the environment.
    const text = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(text).toMatch(/required reviewers on the npm-release environment/);
  });

  test('REQ-REL-2: the pack job packs, checks, signs and verifies every tarball, then uploads them', () => {
    const job = readWorkflow().jobs.pack as Job;
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
    expect(script).not.toContain('forgeseal verify');
    expect(script).toContain('cosign verify-blob --bundle');
    expect(script.indexOf('bun pm pack')).toBeLessThan(script.indexOf('forgeseal sign'));
    expect(script).not.toContain('npm publish');
    expect(script).not.toContain('doppler');
    const sign = job.steps.find((s) => (s.run ?? '').includes('forgeseal sign')) as Step;
    const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@')) as Step;
    expect(upload.if).toBeUndefined();
    expect(upload.with?.name).toBe('release-tarballs-sboms-signatures');
    expect(upload.with?.path).toContain('dist-release/*.tgz');
    expect(upload.with?.path).toContain('dist-release/*.cdx.json');
    expect(upload.with?.path).toContain('dist-release/*.sigstore.json');
    expect(upload.with?.['if-no-files-found']).toBe('error');
    expect(job.steps.indexOf(sign)).toBeLessThan(job.steps.indexOf(upload));
    expect(job.steps.at(-1)).toBe(upload);
  });

  test('REQ-REL-2: the publish job downloads the signed artifact and runs every guard before npm publish', () => {
    const job = readWorkflow().jobs.publish as Job;
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@')) as Step;
    expect(checkout.with?.['fetch-depth']).toBe(0);
    const setupNode = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@')) as Step;
    expect(setupNode.with?.['node-version']).toBe(22);
    expect(setupNode.with?.['registry-url']).toBe('https://registry.npmjs.org');
    const doppler = job.steps.find((s) => s.uses?.startsWith('dopplerhq/cli-action@')) as Step;
    const download = job.steps.find((s) =>
      s.uses?.startsWith('actions/download-artifact@'),
    ) as Step;
    expect(download.with?.name).toBe('release-tarballs-sboms-signatures');
    expect(download.with?.path).toBe('dist-release');
    // Nothing is rebuilt, repacked or re-signed in the publish job.
    expect(runs(job)).not.toContain('bun pm pack');
    expect(runs(job)).not.toContain('forgeseal');
    const at = (needle: string) => {
      const step = job.steps.find((s) => (s.run ?? '').includes(needle)) as Step;
      expect(step).toBeDefined();
      // The job carries the publish condition; no guard can be skipped on its own.
      expect(step.if).toBeUndefined();
      return job.steps.indexOf(step);
    };
    const version = at('GITHUB_REF_NAME#v');
    const onMain = at('git merge-base');
    const auth = at('npm whoami');
    const publish = at('npm publish');
    expect(job.steps.indexOf(download)).toBeLessThan(version);
    expect(job.steps.indexOf(doppler)).toBeLessThan(auth);
    expect(version).toBeLessThan(onMain);
    expect(onMain).toBeLessThan(auth);
    expect(auth).toBeLessThan(publish);
    const versionRun = job.steps[version]?.run as string;
    expect(versionRun).toContain('dist-release/*.tgz');
    expect(versionRun).toContain('exit 1');
    const onMainRun = job.steps[onMain]?.run as string;
    expect(onMainRun).toContain(
      'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
    );
    expect(onMainRun).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(onMainRun).toContain('exit 1');
  });

  test('REQ-REL-2: every guard step lives in the publish job, none in pack or go', () => {
    const wf = readWorkflow();
    for (const name of ['pack', 'go']) {
      const script = runs(wf.jobs[name] as Job);
      for (const guard of ['GITHUB_REF_NAME#v', 'git merge-base', 'npm whoami', 'npm publish']) {
        expect(`${name}: ${guard}: ${script.includes(guard)}`).toBe(`${name}: ${guard}: false`);
      }
    }
  });

  test('REQ-REL-2: release.yml sources the npm token from Doppler, and only the publish job sees DOPPLER_TOKEN', () => {
    const text = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
    expect(text).not.toContain('secrets.NPM_TOKEN');
    expect(text).not.toContain('NPM_TOKEN }}');
    const wf = readWorkflow();
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === 'publish') continue;
      expect(`${name}: ${JSON.stringify(job).includes('DOPPLER_TOKEN')}`).toBe(`${name}: false`);
    }
    const job = wf.jobs.publish as Job;
    const withToken = job.steps.filter((s) => s.env?.DOPPLER_TOKEN !== undefined);
    const publish = job.steps.find((s) => (s.run ?? '').includes('npm publish')) as Step;
    const authCheck = job.steps.find((s) => (s.run ?? '').includes('npm whoami')) as Step;
    expect(withToken).toEqual([authCheck, publish]);
    for (const step of withToken) {
      expect(step.env?.DOPPLER_TOKEN).toMatch(/^\$\{\{ secrets\.DOPPLER_TOKEN \}\}$/);
      expect(step.run).toContain('doppler run --');
    }
    expect(publish.run).toContain('export NODE_AUTH_TOKEN="$NPM_TOKEN"');
  });

  test('REQ-REL-2: release.yml verifies each keyless bundle with cosign against the workflow identity', () => {
    const job = readWorkflow().jobs.pack as Job;
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
    const verify = job.steps.find((s) => (s.run ?? '').includes('cosign verify-blob')) as Step;
    const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@')) as Step;
    expect(job.steps.indexOf(verify)).toBeLessThan(job.steps.indexOf(upload));
  });

  test('REQ-REL-2: release.yml publishes @anyonce/core first with provenance and skips a version already on npm', () => {
    const job = readWorkflow().jobs.publish as Job;
    const publish = (job.steps.find((s) => (s.run ?? '').includes('npm publish')) as Step)
      .run as string;
    expect(publish).toContain('--provenance');
    expect(publish).toContain('--access public');
    expect(publish).toContain('doppler run --');
    const coreLoop = publish.indexOf('for tgz in dist-release/anyonce-core-*.tgz');
    const restLoop = publish.indexOf('for tgz in dist-release/*.tgz');
    expect(coreLoop).toBeGreaterThan(-1);
    expect(restLoop).toBeGreaterThan(coreLoop);
    expect(publish).toContain('dist-release/anyonce-core-*) continue');
    expect(publish).toContain('npm view "$name@$version" version');
    expect(publish.indexOf('npm view')).toBeLessThan(publish.indexOf('npm publish'));
    expect(publish).toContain('return 0');
    // npm reads a bare dir/file.tgz as a GitHub shorthand (run 36011344322); the ./ prefix is required.
    expect(publish).toContain('npm publish "./$tgz"');
    expect(publish).toContain('set -euo pipefail');
  });

  test('REQ-CONF-7: release.yml loads the packed conformance vectors outside the checkout before uploading', () => {
    const job = readWorkflow().jobs.pack as Job;
    const check = job.steps.find((s) =>
      (s.run ?? '').includes('scripts/release/packed-vectors.ts'),
    ) as Step;
    expect(check.run).toBe(
      'bun scripts/release/packed-vectors.ts dist-release/anyonce-conformance-*.tgz',
    );
    expect(check.if).toBeUndefined();
    const pack = job.steps.find((s) => (s.run ?? '').includes('bun pm pack')) as Step;
    const upload = job.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@')) as Step;
    expect(job.steps.indexOf(pack)).toBeLessThan(job.steps.indexOf(check));
    expect(job.steps.indexOf(check)).toBeLessThan(job.steps.indexOf(upload));
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
