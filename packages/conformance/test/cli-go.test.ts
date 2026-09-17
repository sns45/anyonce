import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const goDir = join(import.meta.dir, '../../../go');
const cli = join(import.meta.dir, '../src/cli.ts');
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

describe.skipIf(!hasGo)('CLI against the Go fixture behind httpmw', () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'anyonce-fixture-'));
    const bin = join(tempDir, 'fixture');
    const build = Bun.spawnSync(['go', 'build', '-o', bin, './cmd/fixture'], {
      cwd: goDir,
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) throw new Error(`go build failed: ${build.stderr.toString()}`);
    proc = Bun.spawn([bin, '-addr', '127.0.0.1:0', '-idempotent', '-ttl-ms', '2000'], {
      stdout: 'pipe',
      stderr: 'inherit',
    });
    baseUrl = await readAddress(proc.stdout as ReadableStream<Uint8Array>);
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('REQ-CONF-7: the URL-mode CLI passes every vector against Go httpmw over the wire', async () => {
    const run = Bun.spawn(
      [
        'bun',
        'run',
        cli,
        '--url',
        baseUrl,
        '--capability',
        'short-ttl',
        '--ttl-ms',
        '2000',
        '--report',
        'json',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(run.stdout).text();
    const code = await run.exited;
    const parsed = JSON.parse(stdout) as {
      passed: number;
      results: Array<{ id: string; status: string }>;
    };
    expect(
      parsed.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`),
    ).toEqual([]);
    expect(parsed.passed).toBe(20);
    expect(code).toBe(0);
  }, 60_000);
});

if (!hasGo) {
  test.skip('REQ-CONF-7: skipped because go is not on PATH', () => {});
}
