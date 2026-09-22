/**
 * Proves a packed @anyonce/conformance tarball carries its own vectors (REQ-CONF-7): it unpacks the tarball
 * into a temporary directory outside the repository, imports the unpacked dist, and checks that
 * `loadVectors()` with no argument returns as many vectors as the repository's conformance/vectors holds.
 * Used by the release dry run and by release.yml before publishing.
 */
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The number of vector files under dir/core and dir/profile. */
export function countVectorFiles(dir: string): number {
  let count = 0;
  for (const tier of ['core', 'profile']) {
    count += readdirSync(join(dir, tier)).filter((f) => f.endsWith('.json')).length;
  }
  return count;
}

export type PackedVectorsResult = { packed: number; expected: number; unpackedAt: string };

/** Unpacks the tarball outside `repo`, loads its vectors, and returns both counts; throws on any failure. */
export async function checkPackedVectors(
  tarball: string,
  repo: string,
): Promise<PackedVectorsResult> {
  const expected = countVectorFiles(join(repo, 'conformance/vectors'));
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'anyonce-packed-vectors-')));
  try {
    if (scratch.startsWith(`${realpathSync(repo)}/`)) {
      throw new Error(`the scratch directory ${scratch} is inside the repository`);
    }
    const untar = Bun.spawnSync(['tar', '-xzf', resolve(tarball), '-C', scratch], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (untar.exitCode !== 0) throw new Error(`tar -xzf ${tarball}: ${untar.stderr.toString()}`);
    const entry = join(scratch, 'package/dist/index.js');
    const mod = (await import(entry)) as { loadVectors: () => unknown[] };
    return { packed: mod.loadVectors().length, expected, unpackedAt: scratch };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [tarball] = process.argv.slice(2);
  if (tarball === undefined) {
    console.error('usage: bun scripts/release/packed-vectors.ts <anyonce-conformance-*.tgz>');
    process.exit(2);
  }
  const repo = resolve(import.meta.dir, '../..');
  const { packed, expected, unpackedAt } = await checkPackedVectors(tarball, repo);
  console.log(
    `${tarball}: ${packed} vectors loaded from ${unpackedAt}, repository has ${expected}`,
  );
  if (packed !== expected) process.exit(1);
}
