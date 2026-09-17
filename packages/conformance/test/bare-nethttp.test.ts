import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVectors } from '../src/load';
import { runVectors } from '../src/run';
import { BARE_PASS_IDS, CORE_IDS, PROFILE_IDS } from './catalog';

const goDir = join(import.meta.dir, '../../../go');
const hasGo = Bun.which('go') !== null;

let proc: ReturnType<typeof Bun.spawn> | undefined;
let baseUrl = '';
let tempDir = '';

async function readAddress(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    const match = /listening on (http:\/\/[^\s]+)/.exec(buffer);
    if (match?.[1]) return match[1];
  }
  throw new Error(`fixture exited before printing its address: ${buffer}`);
}

describe.skipIf(!hasGo)('bare net/http fixture', () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'anyonce-fixture-'));
    const bin = join(tempDir, 'fixture');
    const build = Bun.spawnSync(['go', 'build', '-o', bin, './cmd/fixture'], {
      cwd: goDir,
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) throw new Error(`go build failed: ${build.stderr.toString()}`);
    try {
      proc = Bun.spawn([bin, '-addr', '127.0.0.1:0'], { stdout: 'pipe', stderr: 'inherit' });
      baseUrl = await readAddress(proc.stdout as ReadableStream<Uint8Array>);
    } catch (err) {
      proc?.kill();
      throw err;
    }
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('REQ-CONF-2: over a URL the bare net/http fixture passes only the execution-only vectors', async () => {
    const summary = await runVectors({ baseUrl }, loadVectors(), { capabilities: ['short-ttl'] });
    expect(summary.results).toHaveLength(CORE_IDS.length + PROFILE_IDS.length);
    expect(summary.errored).toBe(0);
    expect(summary.notApplicable).toBe(0);
    const passed = summary.results
      .filter((r) => r.status === 'pass')
      .map((r) => r.id)
      .sort();
    expect(passed).toEqual([...BARE_PASS_IDS].sort());
    const failed = summary.results
      .filter((r) => r.status === 'fail')
      .map((r) => r.id)
      .sort();
    expect(failed).toEqual(
      [...CORE_IDS, ...PROFILE_IDS].filter((id) => !BARE_PASS_IDS.includes(id)).sort(),
    );
  }, 30_000);
});

if (!hasGo) {
  test.skip('REQ-CONF-2: skipped because go is not on PATH', () => {});
}
