#!/usr/bin/env bun
/**
 * The 0.1.0 release dry run (CHECKLIST P6; requirements.md 4.9; Q60, Q61, Q65).
 *
 * What it never does: it never runs `npm publish` or `changeset publish`, never creates or pushes a tag,
 * never pushes a branch, never creates a GitHub release, and never contacts Fulcio or Rekor. Signing is
 * forgeseal keyed mode only, against a throwaway CA created under release-dry-run/ca on every run.
 *
 * What it does, all under release-dry-run/ (gitignored):
 *   1. exports HEAD with `git archive` into work/ (uncommitted changes are not part of the dry run);
 *   2. in work/: `bun install --frozen-lockfile`, `bunx changeset version`, `bun install`, `bun run build`,
 *      so the version bump and changelogs land in the scratch copy and never on the branch (Q65);
 *   3. packs every non-private workspace package with `bun pm pack` into tarballs/ and checks each packed
 *      package.json with checkPackedManifest (Q60);
 *   4. runs `go mod tidy -diff` in work/go;
 *   5. per tarball: an SBOM from the unpacked package and its runtime lockfile closure (lockfile.ts), then a
 *      keyed signature over the tarball and over the SBOM, each verified against the throwaway CA;
 *   6. writes summary.json and prints one line per tarball.
 * Git commands inside work/ run with GIT_CEILING_DIRECTORIES set, so they can never reach the real repo.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseBunLock, prunedLockfile } from './lockfile';
import { checkPackedManifest, readPackedManifest } from './manifest';

const FORGESEAL_MODULE = 'github.com/sns45/forgeseal/cmd/forgeseal@v0.5.1';
const EXPECTED_VERSION = '0.1.0';

const repo = resolve(import.meta.dir, '../..');
const out = join(repo, 'release-dry-run');
const dirs = {
  work: join(out, 'work'),
  tarballs: join(out, 'tarballs'),
  unpacked: join(out, 'unpacked'),
  sboms: join(out, 'sboms'),
  signatures: join(out, 'signatures'),
  ca: join(out, 'ca'),
  bin: join(out, 'bin'),
};
const keepWork = process.argv.includes('--keep-work');

type TarballSummary = {
  name: string;
  file: string;
  sha256: string;
  sbom: string;
  signature: string;
  verified: boolean;
};
type Summary = {
  versions: Record<string, string>;
  tarballs: TarballSummary[];
  goModTidyClean: boolean;
};

const rel = (path: string) => relative(out, path);

/** The environment for every child: GOROOT dropped so go uses its own, and git never walks above release-dry-run. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== 'GOROOT') env[k] = v;
  env.GIT_CEILING_DIRECTORIES = out;
  return { ...env, ...extra };
}

type RunResult = { code: number; stdout: string; stderr: string };

/** Paths in the log are shown relative to the repository root. */
const short = (text: string) => text.split(`${repo}/`).join('');

/** Runs a command, echoing it and its output, and returns the output to the caller as well. */
function run(
  cmd: string[],
  cwd: string,
  opts: { allowFail?: boolean; env?: Record<string, string>; label?: string } = {},
): RunResult {
  const where = relative(repo, cwd) || '.';
  console.log(`$ ${short(cmd.join(' '))}   (in ${where})${opts.label ? `   # ${opts.label}` : ''}`);
  const proc = Bun.spawnSync(cmd, { cwd, env: childEnv(opts.env), stdout: 'pipe', stderr: 'pipe' });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (stdout.trim() !== '') console.log(short(stdout.trimEnd()));
  if (stderr.trim() !== '') console.log(short(stderr.trimEnd()));
  if (proc.exitCode !== 0 && opts.allowFail !== true) {
    throw new Error(`${cmd.join(' ')} exited ${proc.exitCode}`);
  }
  return { code: proc.exitCode ?? 1, stdout, stderr };
}

function step(title: string): void {
  console.log(`\n== ${title}`);
}

function goBinary(): string {
  const go = process.env.GO ?? Bun.which('go');
  if (go === undefined || go === null)
    throw new Error('go is not on PATH (set GO to the go binary)');
  return go;
}

/** forgeseal on PATH, else in `$(go env GOPATH)/bin`, else installed into release-dry-run/bin. */
function locateForgeseal(go: string): string {
  const onPath = Bun.which('forgeseal');
  if (onPath !== null) return onPath;
  const gopath = run([go, 'env', 'GOPATH'], repo).stdout.trim();
  for (const candidate of [join(gopath, 'bin', 'forgeseal'), join(dirs.bin, 'forgeseal')]) {
    if (existsSync(candidate)) return candidate;
  }
  mkdirSync(dirs.bin, { recursive: true });
  run([go, 'install', FORGESEAL_MODULE], repo, { env: { GOBIN: dirs.bin } });
  return join(dirs.bin, 'forgeseal');
}

type WorkspacePackage = { dir: string; name: string; version: string };

/** Every non-private package under work/packages; examples and fixtures are private and never packed. */
function publishedPackages(): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  const root = join(dirs.work, 'packages');
  for (const entry of readdirSync(root).sort()) {
    const manifestPath = join(root, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name: string;
      version: string;
      private?: boolean;
    };
    if (pkg.private === true) continue;
    out.push({ dir: join(root, entry), name: pkg.name, version: pkg.version });
  }
  return out;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A keyed forgeseal verify passes only when it exits 0 and reports PASSED. */
function verify(
  forgeseal: string,
  artifact: string,
  bundle: string,
  ca: string,
  label?: string,
): boolean {
  const res = run(
    [forgeseal, 'verify', '--artifact', artifact, '--bundle', bundle, '--ca-cert', ca],
    out,
    label === undefined ? { allowFail: true } : { allowFail: true, label },
  );
  return res.code === 0 && res.stderr.includes('Signature verification: PASSED');
}

/**
 * Things the real publish needs that NFR-3 does not cover. They are reported, not failed on: npm
 * provenance checks `repository.url` against the workflow's repository, and a tarball without a LICENSE
 * or README ships without them.
 */
function publishNotes(name: string, manifest: unknown, tarball: string): string[] {
  const notes: string[] = [];
  const listing = Bun.spawnSync(['tar', '-tzf', tarball]).stdout.toString().split('\n');
  const repository = (manifest as { repository?: unknown }).repository;
  if (repository === undefined) notes.push(`${name}: package.json has no repository field`);
  if (!listing.some((f) => /^package\/licen[cs]e/i.test(f))) notes.push(`${name}: no LICENSE file`);
  if (!listing.some((f) => /^package\/readme/i.test(f))) notes.push(`${name}: no README file`);
  return notes;
}

function main(): void {
  const failures: string[] = [];
  const notes: string[] = [];

  step('clean release-dry-run');
  for (const dir of [
    dirs.work,
    dirs.tarballs,
    dirs.unpacked,
    dirs.sboms,
    dirs.signatures,
    dirs.ca,
  ]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  rmSync(join(out, 'summary.json'), { force: true });

  step('export HEAD');
  const head = run(['git', 'rev-parse', 'HEAD'], repo).stdout.trim();
  const dirty = run(['git', 'status', '--porcelain'], repo).stdout.trim();
  if (dirty !== '')
    console.log('note: the working tree has uncommitted changes; the dry run uses HEAD only');
  run(['sh', '-c', `git archive --format=tar HEAD | tar -x -C '${dirs.work}'`], repo);
  console.log(`exported ${head}`);

  step('version (changesets, scratch copy only)');
  run(['bun', 'install', '--frozen-lockfile'], dirs.work);
  run(['bunx', 'changeset', 'version'], dirs.work);
  run(['bun', 'install'], dirs.work);

  const packages = publishedPackages();
  const versions: Record<string, string> = {};
  for (const pkg of packages) {
    versions[pkg.name] = pkg.version;
    if (pkg.version !== EXPECTED_VERSION)
      failures.push(`${pkg.name} is at ${pkg.version}, expected ${EXPECTED_VERSION}`);
  }
  console.log(JSON.stringify(versions, null, 2));

  step('build');
  run(['bun', 'run', 'build'], dirs.work);

  step('pack and check the packed manifests');
  const packed: Array<{ pkg: WorkspacePackage; tarball: string }> = [];
  for (const pkg of packages) {
    const before = new Set(readdirSync(dirs.tarballs));
    run(['bun', 'pm', 'pack', '--destination', dirs.tarballs], pkg.dir);
    const created = readdirSync(dirs.tarballs).filter((f) => f.endsWith('.tgz') && !before.has(f));
    if (created.length !== 1)
      throw new Error(`${pkg.name}: expected one new tarball, found ${created.join(', ')}`);
    const tarball = join(dirs.tarballs, created[0] as string);
    const manifest = readPackedManifest(tarball);
    const problems = checkPackedManifest(manifest, pkg.name);
    const peers =
      (manifest as { peerDependencies?: Record<string, string> }).peerDependencies ?? {};
    const corePeer = peers['@anyonce/core'];
    console.log(
      `${pkg.name}: ${problems.length === 0 ? 'packed manifest ok' : 'PROBLEMS'}${corePeer === undefined ? '' : `, peer @anyonce/core ${corePeer}`}`,
    );
    for (const problem of problems) console.log(`  ${problem}`);
    failures.push(...problems);
    notes.push(...publishNotes(pkg.name, manifest, tarball));
    packed.push({ pkg, tarball });
  }

  step('go mod tidy');
  const go = goBinary();
  const tidy = run([go, 'mod', 'tidy', '-diff'], join(dirs.work, 'go'), { allowFail: true });
  const goModTidyClean = tidy.code === 0 && tidy.stdout.trim() === '';
  console.log(`go mod tidy -diff: ${goModTidyClean ? 'clean' : 'NOT clean'}`);
  if (!goModTidyClean) failures.push('go mod tidy -diff is not clean');

  step('forgeseal: throwaway CA, SBOM, keyed signatures, verification');
  const forgeseal = locateForgeseal(go);
  console.log(`forgeseal: ${short(forgeseal)}`);
  run([forgeseal, 'version'], out, { allowFail: true });
  const caCert = join(dirs.ca, 'signing-ca.crt');
  const caKey = join(dirs.ca, 'signing-ca.key');
  // forgeseal has no "ca init": the first keyed sign creates the CA at the paths given, and `ca export`
  // then prints it. The explicit paths keep the CA out of ~/.forgeseal.
  const lock = parseBunLock(readFileSync(join(dirs.work, 'bun.lock'), 'utf8'));
  const tarballs: TarballSummary[] = [];
  for (const { pkg, tarball } of packed) {
    const base = basename(tarball, '.tgz');
    const unpacked = join(dirs.unpacked, base);
    mkdirSync(unpacked, { recursive: true });
    run(['tar', '-xzf', tarball, '-C', unpacked], out);
    const pkgDir = join(unpacked, 'package');
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      name: string;
    };
    const pruned = prunedLockfile(lock, manifest);
    writeFileSync(join(pkgDir, 'bun.lock'), `${JSON.stringify(pruned, null, 2)}\n`);
    console.log(
      `${pkg.name}: SBOM lockfile with ${Object.keys(pruned.packages).length} runtime packages`,
    );

    const sbom = join(dirs.sboms, `${base}.cdx.json`);
    run([forgeseal, 'sbom', '--dir', pkgDir, '-o', sbom], out);
    const bom = JSON.parse(readFileSync(sbom, 'utf8')) as {
      metadata?: { component?: { name?: string; version?: string } };
    };
    if (
      bom.metadata?.component?.name !== pkg.name ||
      bom.metadata.component.version !== pkg.version
    ) {
      failures.push(
        `${pkg.name}: SBOM names ${bom.metadata?.component?.name}@${bom.metadata?.component?.version}`,
      );
    }

    const tarballBundle = join(dirs.signatures, `${base}.tgz.sigstore.json`);
    const sbomBundle = join(dirs.signatures, `${base}.cdx.json.sigstore.json`);
    for (const [artifact, bundle] of [
      [tarball, tarballBundle],
      [sbom, sbomBundle],
    ] as const) {
      run(
        [
          forgeseal,
          'sign',
          '--keyed',
          '--ca-cert',
          caCert,
          '--ca-key',
          caKey,
          '--artifact',
          artifact,
          '--bundle',
          bundle,
        ],
        out,
      );
    }
    const verified =
      verify(forgeseal, tarball, tarballBundle, caCert) &&
      verify(forgeseal, sbom, sbomBundle, caCert);
    // The check is meaningful only if a wrong artifact fails: the tarball's bundle must not verify the SBOM.
    const crossCheckRejected = !verify(
      forgeseal,
      sbom,
      tarballBundle,
      caCert,
      'negative check: the wrong artifact must FAIL',
    );
    if (!verified) failures.push(`${pkg.name}: signature verification failed`);
    if (!crossCheckRejected) failures.push(`${pkg.name}: a bundle verified the wrong artifact`);

    tarballs.push({
      name: pkg.name,
      file: rel(tarball),
      sha256: sha256(tarball),
      sbom: rel(sbom),
      signature: rel(tarballBundle),
      verified: verified && crossCheckRejected,
    });
  }
  const exported = run([forgeseal, 'ca', 'export', '--ca-cert', caCert], out).stdout;
  if (exported !== readFileSync(caCert, 'utf8'))
    failures.push('forgeseal ca export does not match the throwaway CA');

  const summary: Summary = { versions, tarballs, goModTidyClean };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  if (!keepWork) {
    // work/ holds a full copy of the repository, test files included; removing it keeps `bun test` path
    // filters from ever picking those copies up.
    rmSync(dirs.work, { recursive: true, force: true });
  }

  step('summary');
  const width = Math.max(...tarballs.map((t) => t.name.length));
  for (const t of tarballs) {
    console.log(
      `${t.name.padEnd(width)}  ${versions[t.name]}  ${t.file}  sha256 ${t.sha256.slice(0, 16)}  sbom ${t.sbom}  verified ${t.verified}`,
    );
  }
  console.log(`go mod tidy clean: ${goModTidyClean}`);
  console.log(`summary: ${relative(repo, join(out, 'summary.json'))}`);
  console.log('nothing was published, tagged, pushed or signed keyless');
  if (notes.length > 0) {
    console.log(`\nbefore the real publish (${notes.length} notes, not failures):`);
    for (const n of notes) console.log(`  ${n}`);
  }

  if (failures.length > 0) {
    console.error(`\nDRY RUN FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log('\nDRY RUN OK');
}

main();
