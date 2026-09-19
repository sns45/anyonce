/**
 * REQ-CONF-8: one collector per RowKind, plus normalize/readResults/writeResults for the committed golden
 * files under conformance/results/. No collector here is invoked by scripts/report.test.ts (Task 4); they run
 * for real from scripts/report.ts, which needs the compose stacks up.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv } from 'node:process';
import type { RunSummary, VectorResult } from '@anyonce/conformance';
import { runConformance } from '@anyonce/conformance';
import { MemoryStore, type Store } from '@anyonce/core';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { DynamoDbStore, ensureTable } from '@anyonce/stores/dynamodb';
import { ensureSchema, PostgresStore } from '@anyonce/stores/postgres';
import { fromIoredis, RedisStore } from '@anyonce/stores/redis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { CAPABILITY_TTL_MS, GO_REGRADED_VECTOR_ID, type ReportRow } from './rows';

const GO_ROOT = join(import.meta.dir, '..', '..', 'go');
const CONFORMANCE_CLI = join(
  import.meta.dir,
  '..',
  '..',
  'packages',
  'conformance',
  'src',
  'cli.ts',
);

const REPO_ROOT = join(import.meta.dir, '..', '..');
const WORKER_DIR = join(REPO_ROOT, 'conformance', 'report', 'worker');
const WORKER_CONFIG = join(WORKER_DIR, 'wrangler.jsonc');
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');

/** wrangler dev prints "[wrangler:info] Ready on http://127.0.0.1:<port>" once workerd is listening. That
 * line is the readiness signal: the collector never sleeps a fixed amount and never polls the port. */
const WRANGLER_READY_PATTERN = /Ready on (http:\S+)/;

/** Generous, because a cold wrangler dev bundles the worker before workerd starts; about ten seconds is
 * typical. A hung start has to fail with a message rather than block the whole collection forever. */
const WRANGLER_READY_TIMEOUT_MS = 120_000;

const PORT_PATTERN = /127\.0\.0\.1:\d+/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR escapes wrangler emits is the point.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** N6: redacts an ephemeral or fixed port so a connection error never leaks one into a committed result. */
function redactPorts(text: string): string {
  return text.replace(PORT_PATTERN, '127.0.0.1:PORT');
}

function redactResult(result: VectorResult): VectorResult {
  const steps = result.steps.map((step) => ({
    ...step,
    failures: step.failures.map(redactPorts),
  }));
  const withSteps: VectorResult = { ...result, steps };
  return result.error === undefined
    ? withSteps
    : { ...withSteps, error: redactPorts(result.error) };
}

/**
 * REQ-CONF-8: strips anything not in the RunSummary shape (in particular the CLI's `target` and
 * `generatedAt`), sorts `results` by id so the committed JSON is deterministic, and redacts any
 * `127.0.0.1:<port>` in an error or failure string (N6) so a committed result never leaks an ephemeral port.
 */
export function normalize(summary: RunSummary): RunSummary {
  const results = [...summary.results]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(redactResult);
  return {
    results,
    passed: summary.passed,
    failed: summary.failed,
    notApplicable: summary.notApplicable,
    errored: summary.errored,
  };
}

/** Reads every committed conformance/results/<id>.json into a map keyed by row id. */
export function readResults(dir: string): Map<string, RunSummary> {
  const out = new Map<string, RunSummary>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const summary = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunSummary;
    out.set(id, summary);
  }
  return out;
}

/** Writes one conformance/results/<id>.json per entry, JSON.stringify(value, null, 2) plus a trailing newline. */
export function writeResults(dir: string, results: ReadonlyMap<string, RunSummary>): void {
  for (const [id, summary] of results) {
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

/** N12: removes every committed conformance/results/<id>.json whose id is not in `keep`, returning the file
 * names removed so the caller can report them. */
export function pruneStaleResultFiles(dir: string, keep: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!keep.has(id)) {
      unlinkSync(join(dir, name));
      removed.push(name);
    }
  }
  return removed;
}

/**
 * REQ-CONF-8 / N9: turns a row's capabilities into the flags a runner needs, in that runner's flag style
 * ('--' for the TypeScript CLI, '-' for the Go CLI). Pure, so a test can assert on the argv without spawning a
 * process. short-ttl always carries a matching --ttl-ms / -ttl-ms so a runner never grades a capability the
 * target was not actually configured with (B1).
 */
export function capabilityArgs(
  capabilities: readonly ReportRow['capabilities'][number][],
  style: '--' | '-',
): string[] {
  const flags: string[] = [];
  for (const capability of capabilities) flags.push(`${style}capability`, capability);
  if (capabilities.includes('short-ttl')) flags.push(`${style}ttl-ms`, String(CAPABILITY_TTL_MS));
  return flags;
}

/** Pure: the argv the TypeScript CLI is invoked with for a ts-url row. */
export function buildTsUrlArgs(row: ReportRow, url: string): string[] {
  return ['--url', url, '--report', 'json', ...capabilityArgs(row.capabilities, '--')];
}

/** Pure: the argv go/cmd/conformance is invoked with for a go-url row. */
export function buildGoUrlArgs(row: ReportRow, url: string): string[] {
  return ['-url', url, ...capabilityArgs(row.capabilities, '-')];
}

async function buildStore(name: string): Promise<{ store: Store; cleanup: () => Promise<void> }> {
  switch (name) {
    case 'memory':
      return { store: new MemoryStore(), cleanup: async () => {} };
    case 'dynamodb': {
      const client = new DynamoDBClient({
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:18000',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      });
      const table = `anyonce_report_${Date.now()}`;
      await ensureTable(client, table);
      return {
        store: new DynamoDbStore({ client, tableName: table }),
        cleanup: async () => {
          client.destroy();
        },
      };
    }
    case 'redis': {
      const client = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false });
      return {
        store: new RedisStore({ adapter: fromIoredis(client), prefix: `report${Date.now()}:` }),
        cleanup: async () => {
          await client.quit();
        },
      };
    }
    case 'postgres': {
      const client = new Pool({
        connectionString: 'postgres://anyonce:anyonce@127.0.0.1:15432/anyonce',
      });
      await ensureSchema(client);
      return {
        store: new PostgresStore({ query: client }),
        cleanup: async () => {
          await client.end();
        },
      };
    }
    default:
      throw new Error(`ts-in-process collector: unknown store "${name}"`);
  }
}

/**
 * REQ-CONF-8: the anyonce TypeScript rows on memory, DynamoDB, Redis and Postgres. Wires withIdempotency
 * exactly as packages/stores/services/*.conformance.test.ts do, driven by the row's own capabilities (N9).
 */
export async function collectTsInProcess(row: ReportRow): Promise<RunSummary> {
  const { store, cleanup } = await buildStore(row.store);
  try {
    const handler = withIdempotency(createFixtureApp().fetch, {
      store,
      required: true,
      ttlMs: CAPABILITY_TTL_MS,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    const { summary } = await runConformance({
      target: handler,
      capabilities: [...row.capabilities],
      report: 'json',
    });
    return summary;
  } finally {
    await cleanup();
  }
}

async function readAllText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return '';
  return await new Response(stream).text();
}

async function waitForListeningUrl(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) throw new Error('process produced no stdout');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`process exited before printing its listening address: ${buffer}`);
    buffer += decoder.decode(value, { stream: true });
    const match = /listening on (http:\S+)/.exec(buffer);
    if (match) {
      const url = match[1];
      if (url === undefined) throw new Error('unreachable: regex match with no capture group');
      reader.releaseLock();
      return url;
    }
  }
}

/** N7: runs go/cmd/conformance against a running URL and parses its JSON report, naming `context` (the row and
 * the URL), the exact command and the start of stderr when the process fails or produces no valid JSON, rather
 * than surfacing a bare SyntaxError. */
async function runGoConformanceCli(args: readonly string[], context: string): Promise<RunSummary> {
  const proc = Bun.spawn({
    cmd: ['go', 'run', './cmd/conformance', ...args, '-report', 'json'],
    cwd: GO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([readAllText(proc.stdout), readAllText(proc.stderr)]);
  const code = await proc.exited;
  const command = `go run ./cmd/conformance ${args.join(' ')}`;
  const stderrExcerpt = stderr.slice(0, 500) || '(empty)';
  if (code !== 0 && code !== 1) {
    throw new Error(`${context}: ${command} exited ${code}, stderr: ${stderrExcerpt}`);
  }
  try {
    return JSON.parse(stdout) as RunSummary;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${context}: ${command} did not produce valid JSON (exit ${code}, stderr: ${stderrExcerpt}): ${message}`,
    );
  }
}

/** N7: the mirror of runGoConformanceCli for the TypeScript CLI. Shared by the ts-url rows and the
 * workerd-url rows, so both name the row, the URL, the exact command and the start of stderr when the CLI
 * fails or produces no valid JSON. */
async function runTsConformanceCli(args: readonly string[], context: string): Promise<RunSummary> {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', CONFORMANCE_CLI, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([readAllText(proc.stdout), readAllText(proc.stderr)]);
  const code = await proc.exited;
  const command = `bun run ${CONFORMANCE_CLI} ${args.join(' ')}`;
  const stderrExcerpt = stderr.slice(0, 500) || '(empty)';
  if (code !== 0 && code !== 1) {
    throw new Error(`${context}: ${command} exited ${code}, stderr: ${stderrExcerpt}`);
  }
  try {
    return JSON.parse(stdout) as RunSummary;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${context}: ${command} did not produce valid JSON (exit ${code}, stderr: ${stderrExcerpt}): ${message}`,
    );
  }
}

/** REQ-CONF-8: the anyonce Go rows. Starts go/cmd/fixture on the row's own fixed port with -idempotent
 * -store <name>, drives it with go/cmd/conformance using the row's own capabilities (N9), then stops the
 * fixture. A fixed port (N6) means an unreachable-fixture error never embeds an ephemeral port. */
/**
 * Path of the compiled fixture binary, built once and reused by all five Go rows.
 *
 * The fixture is built and then run as a binary rather than driven with `go run`, and that is load bearing
 * rather than an optimisation. `go run` compiles to a temporary binary and executes it as a CHILD process,
 * so killing the `go run` process leaves the server it started holding the port. Observed exactly that: a
 * completed collection left five `fixture` processes on 18901 to 18905, and the next run died with
 * "listen tcp 127.0.0.1:18901: bind: address already in use". Spawning the binary directly means the process
 * the collector kills is the server. packages/conformance/test/cli-go.test.ts builds first for the same
 * reason.
 */
let fixtureBinary: Promise<string> | undefined;

async function buildGoFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'anyonce-report-fixture-'));
  const bin = join(dir, 'fixture');
  const build = Bun.spawn({
    cmd: ['go', 'build', '-o', bin, './cmd/fixture'],
    cwd: GO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    readAllText(build.stdout),
    readAllText(build.stderr),
  ]);
  const code = await build.exited;
  if (code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`go build ./cmd/fixture failed with exit ${code}: ${stderr || stdout}`);
  }
  return bin;
}

export async function collectGoUrl(row: ReportRow): Promise<RunSummary> {
  if (row.port === undefined) {
    throw new Error(`go-url collector: row "${row.id}" has no fixed port`);
  }
  const addr = `127.0.0.1:${row.port}`;
  fixtureBinary ??= buildGoFixture();
  const bin = await fixtureBinary;
  const fixture = Bun.spawn({
    cmd: [
      bin,
      '-idempotent',
      '-addr',
      addr,
      '-store',
      row.store,
      '-ttl-ms',
      String(CAPABILITY_TTL_MS),
    ],
    cwd: GO_ROOT,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  try {
    const url = await waitForListeningUrl(fixture.stdout);
    return await runGoConformanceCli(buildGoUrlArgs(row, url), `row "${row.id}" (${url})`);
  } finally {
    fixture.kill();
    // Awaiting the exit is what makes the port free for the next row rather than merely requested to be.
    await fixture.exited;
  }
}

const THIRD_PARTY_PORTS: Readonly<Record<string, number>> = {
  'hono-idempotency': 13001,
  idempo: 13002,
  fiber: 13003,
};

function thirdPartyUrl(row: ReportRow): string {
  const port = THIRD_PARTY_PORTS[row.id];
  if (port === undefined) {
    throw new Error(`ts-url collector: no known port for row "${row.id}"`);
  }
  return `http://127.0.0.1:${port}`;
}

/** Shells out to the TypeScript CLI with the row's own capabilities (N9, fixes B1), then splices in the Go
 * runner's result for core/header-name-case-insensitive (Q52), which the Fetch Headers class cannot
 * discriminate. */
export async function collectTsUrl(row: ReportRow): Promise<RunSummary> {
  const url = thirdPartyUrl(row);

  // The Go regrade runs FIRST, before the TypeScript pass, and the order is load bearing. Both passes drive
  // the same live container, and GO_REGRADED_VECTOR_ID uses one fixed key on both of them. The fixture
  // contract's POST /reset clears the handler counter but cannot clear the implementation's own idempotency
  // store, and every third-party target here is configured with a 2000 ms TTL, so a second pass that lands
  // inside that window finds the first pass's record still live and is answered by a replay: the target
  // returns the expected status with the handler never running, and the vector fails on
  // handlerInvocations rather than on anything the implementation did wrong.
  //
  // Observed, not theorised: with the TypeScript pass first, all three third parties failed this vector with
  // "first: handlerInvocations: expected 1, got 0", and all three passed it when the Go CLI was pointed at
  // the same container by hand. Publishing that would have been two false accusations against other people's
  // projects. Running the Go pass first means it meets a clean store; the TypeScript pass then hits the
  // replay instead, and its result for this one vector is the one being discarded anyway.
  const goSummary = await runGoConformanceCli(
    ['-url', url, '-only', GO_REGRADED_VECTOR_ID],
    `row "${row.id}" (${url})`,
  );
  const goResult = goSummary.results.find((r) => r.id === GO_REGRADED_VECTOR_ID);
  if (goResult === undefined) {
    throw new Error(`go run ./cmd/conformance -only ${GO_REGRADED_VECTOR_ID} produced no result`);
  }

  const tsSummary = await runTsConformanceCli(buildTsUrlArgs(row, url), `row "${row.id}" (${url})`);
  const results = tsSummary.results.map((r) => (r.id === GO_REGRADED_VECTOR_ID ? goResult : r));
  return {
    results,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    notApplicable: results.filter((r) => r.status === 'not-applicable').length,
    errored: results.filter((r) => r.status === 'error').length,
  };
}

/** A rejection that fires after `ms`, with `cancel` so the winner of a race never leaves a timer pending. */
function rejectAfter(ms: number, message: string): { promise: Promise<never>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(message)), ms);
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

function tail(text: string): string {
  const clean = text.replace(ANSI_PATTERN, '').trimEnd();
  return clean.length > 1000 ? `...${clean.slice(-1000)}` : clean || '(no output)';
}

/**
 * Waits for wrangler dev's own readiness line rather than sleeping or polling, so a slow bundle is waited out
 * and a wrangler that dies (a port already bound, a bundle error) fails immediately with its output rather
 * than after the full timeout. Once ready, stdout keeps being drained in the background: wrangler logs every
 * request it serves, and a full pipe buffer would stall the server mid-run.
 */
async function waitForWranglerUrl(
  stream: ReadableStream<Uint8Array> | null,
  context: string,
): Promise<string> {
  if (stream === null) throw new Error(`${context}: wrangler dev produced no stdout`);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const timer = rejectAfter(
    WRANGLER_READY_TIMEOUT_MS,
    `${context}: wrangler dev was not ready within ${WRANGLER_READY_TIMEOUT_MS} ms`,
  );
  let buffer = '';
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timer.promise]);
      if (chunk.done) {
        throw new Error(`${context}: wrangler dev exited before it was ready: ${tail(buffer)}`);
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const url = WRANGLER_READY_PATTERN.exec(buffer)?.[1];
      if (url !== undefined) {
        reader.releaseLock();
        void readAllText(stream).catch(() => {});
        return url;
      }
    }
  } finally {
    timer.cancel();
  }
}

/**
 * REQ-CONF-8: the anyonce Durable Objects and D1 rows. Both stores exist only inside workerd, and the vitest
 * workers pool that proves them in packages/stores/workers/*.test.ts has no filesystem, so no run summary can
 * be written from inside it. conformance/report/worker/ mounts the same wiring behind HTTP instead:
 * wrangler dev --local serves it, the ordinary TypeScript URL runner drives it, and the process is killed in
 * a finally so a failed run never leaks it.
 *
 * The row's own fixed port (N6) keeps the two rows off each other, and --persist-to a per-row directory that
 * is cleared on both sides of the run keeps workerd's local state from carrying between runs, so a rerun on
 * an unchanged tree produces the same summary.
 */
export async function collectWorkerdUrl(row: ReportRow): Promise<RunSummary> {
  if (row.port === undefined) {
    throw new Error(`workerd-url collector: row "${row.id}" has no fixed port`);
  }
  const state = join(WORKER_DIR, '.wrangler', 'report-state', row.id);
  rmSync(state, { recursive: true, force: true });
  const wrangler = Bun.spawn({
    cmd: [
      WRANGLER_BIN,
      'dev',
      '--config',
      WORKER_CONFIG,
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(row.port),
      '--var',
      `ANYONCE_STORE:${row.store}`,
      '--persist-to',
      state,
    ],
    env: { ...processEnv, WRANGLER_SEND_METRICS: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // stdout is drained by waitForWranglerUrl once it has the address; stderr needs the same treatment for the
  // same reason. wrangler writes bundler and deprecation notices there, and a full OS pipe buffer would block
  // the process mid-run with nothing to time it out.
  void readAllText(wrangler.stderr).catch(() => {});
  try {
    const url = await waitForWranglerUrl(wrangler.stdout, `row "${row.id}"`);
    return await runTsConformanceCli(buildTsUrlArgs(row, url), `row "${row.id}" (${url})`);
  } finally {
    wrangler.kill();
    await wrangler.exited;
    rmSync(state, { recursive: true, force: true });
  }
}

/** Dispatches to the collector for a row's kind. */
export function collect(row: ReportRow): Promise<RunSummary> {
  switch (row.kind) {
    case 'ts-in-process':
      return collectTsInProcess(row);
    case 'ts-url':
      return collectTsUrl(row);
    case 'go-url':
      return collectGoUrl(row);
    case 'workerd-url':
      return collectWorkerdUrl(row);
  }
}
