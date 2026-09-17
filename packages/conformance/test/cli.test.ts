import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createFixtureApp } from '@anyonce/fixture-hono';

const cli = join(import.meta.dir, '../src/cli.ts');
let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: createFixtureApp().fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe('anyonce-conformance CLI', () => {
  test('REQ-CONF-7: exits 1 with a json report when vectors fail against a bare fixture', async () => {
    const { code, stdout } = await run(['--url', baseUrl, '--tier', 'core', '--report', 'json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.failed).toBeGreaterThan(0);
    expect(parsed.target).toBe(baseUrl);
  }, 60_000);

  test('REQ-CONF-7: exits 0 with markdown when only passing vectors are selected', async () => {
    const { code, stdout } = await run([
      '--url',
      baseUrl,
      '--only',
      'core/post-executes-once',
      '--report',
      'markdown',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('| core/post-executes-once | core | pass |  |');
  }, 60_000);

  test('REQ-CONF-7: declares capabilities, writes --out and rejects a ttl above the short-ttl bound', async () => {
    const out = join(import.meta.dir, '../.cli-out.xml');
    const ok = await run([
      '--url',
      baseUrl,
      '--only',
      'core/expiry-executes-again',
      '--capability',
      'short-ttl',
      '--ttl-ms',
      '2000',
      '--report',
      'junit',
      '--out',
      out,
    ]);
    expect(ok.code).toBe(0);
    expect(await Bun.file(out).text()).toContain(
      '<testcase classname="core" name="core/expiry-executes-again"/>',
    );
    const bad = await run(['--url', baseUrl, '--capability', 'short-ttl', '--ttl-ms', '5000']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('short-ttl');
    const noUrl = await run(['--tier', 'core']);
    expect(noUrl.code).toBe(2);
    expect(noUrl.stderr).toContain('--url');
  }, 60_000);

  test('REQ-CONF-7: a value starting with -- is a usage error, not the next flag value', async () => {
    const { code, stderr } = await run(['--url', '--tier', 'core']);
    expect(code).toBe(2);
    expect(stderr).toContain('--url');
  }, 60_000);
});
