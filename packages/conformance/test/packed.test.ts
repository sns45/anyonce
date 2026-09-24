import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { loadVectors } from '../src/load';

// The packed tarball must carry its own vectors: an installed @anyonce/conformance has no repository around
// it. Needs `bun run build` first (the tarball ships dist).
const pkgDir = join(import.meta.dir, '..');
const repoRoot = realpathSync(join(pkgDir, '../..'));
const repoVectors = join(repoRoot, 'conformance/vectors');

let scratch = '';
let unpacked = '';

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'anyonce-conformance-pack-')));
  const pack = Bun.spawnSync(['bun', 'pm', 'pack', '--destination', scratch], {
    cwd: pkgDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (pack.exitCode !== 0) throw new Error(`bun pm pack failed: ${pack.stderr.toString()}`);
  const tarball = readdirSync(scratch).find((f) => f.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('bun pm pack wrote no tarball');
  const untar = Bun.spawnSync(['tar', '-xzf', join(scratch, tarball), '-C', scratch]);
  if (untar.exitCode !== 0) throw new Error('tar failed');
  unpacked = join(scratch, 'package');
});

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('packed @anyonce/conformance', () => {
  test('REQ-CONF-7: the packed tarball loads every vector from outside the repository', async () => {
    expect(unpacked.startsWith(`${repoRoot}/`)).toBe(false);
    expect(existsSync(join(unpacked, 'dist/index.js'))).toBe(true);
    const mod = (await import(join(unpacked, 'dist/index.js'))) as {
      loadVectors: typeof loadVectors;
    };
    const packed = mod.loadVectors();
    const repo = loadVectors(repoVectors);
    expect(repo.length).toBeGreaterThan(0);
    expect(packed.map((v) => v.id)).toEqual(repo.map((v) => v.id));
    expect(packed).toEqual(repo);
  });

  test('REQ-CONF-7: the packed CLI runs every core vector against a URL from outside the repository', async () => {
    // A bare fixture has no idempotency layer, so vectors fail (exit 1); the point is that all of them ran.
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: createFixtureApp().fetch });
    try {
      const proc = Bun.spawn(
        [
          'bun',
          join(unpacked, 'dist/cli.js'),
          '--url',
          `http://127.0.0.1:${server.port}`,
          '--tier',
          'core',
          '--report',
          'json',
        ],
        { cwd: scratch, stdout: 'pipe', stderr: 'pipe' },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      expect(`${code} ${stderr}`).toBe('1 ');
      const report = JSON.parse(stdout) as { results: Array<{ id: string }> };
      const core = loadVectors(repoVectors).filter((v) => v.id.startsWith('core/'));
      expect(report.results.map((r) => r.id).sort()).toEqual(core.map((v) => v.id).sort());
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
