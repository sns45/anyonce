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
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
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

/** Bounded retry for waitForWorkerReady's HTTP probe fallback (REQ-CONF-8 Step 2): five attempts half a
 * second apart, so the worst case adds two and a half seconds on top of whatever the Ready line would have
 * taken. Never a fixed sleep on its own: WRANGLER_READY_TIMEOUT_MS above remains the ceiling if neither the
 * Ready line nor the probe ever succeeds. */
const WRANGLER_PROBE_ATTEMPTS = 5;
const WRANGLER_PROBE_INTERVAL_MS = 500;

/** The Go fixture is already built by the time it is spawned, so it should listen almost immediately. */
const FIXTURE_READY_TIMEOUT_MS = 30_000;

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
          // The table name carries a timestamp, so without this every run leaves another table behind in a
          // long lived DynamoDB Local. Best effort: a failed delete must not fail the row it belongs to.
          try {
            await client.send(new DeleteTableCommand({ TableName: table }));
          } catch {
            // The row's result is what matters; a leftover table is a local housekeeping problem.
          }
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

/**
 * Waits for go/cmd/fixture's own "listening on http://ADDR" line, with the same guards the wrangler path
 * uses: a deadline so a fixture that starts but never prints an address fails with a message instead of
 * hanging the whole collection, and a background drain afterwards so a full stdout pipe can never stall the
 * server mid-run. The fixture prints one line and logs nothing per request today, so the drain is
 * belt and braces rather than load bearing, but the asymmetry with waitForWranglerUrl was not worth keeping.
 */
async function waitForListeningUrl(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) throw new Error('process produced no stdout');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = rejectAfter(
    FIXTURE_READY_TIMEOUT_MS,
    `fixture was not listening within ${FIXTURE_READY_TIMEOUT_MS} ms`,
  );
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline.promise]);
      if (chunk.done) {
        throw new Error(`process exited before printing its listening address: ${buffer}`);
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const match = /listening on (http:\S+)/.exec(buffer);
      if (match) {
        const url = match[1];
        if (url === undefined) throw new Error('unreachable: regex match with no capture group');
        reader.releaseLock();
        void readAllText(stream).catch(() => {});
        return url;
      }
    }
  } finally {
    deadline.cancel();
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
  // Every Go row reuses this binary, so it cannot be removed after one row. Removing it when the process
  // ends is what stops each run leaving roughly fourteen megabytes behind in the temp directory.
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
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
  // the same container by hand. Publishing that would have been three false accusations against other people's
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

/** REQ-CONF-8: strips any SGR (color) escapes before matching WRANGLER_READY_PATTERN, so wrangler dev's Ready
 * line parses whether or not color output is enabled. */
function parseReadyUrl(buffer: string): string | undefined {
  return WRANGLER_READY_PATTERN.exec(buffer.replace(ANSI_PATTERN, ''))?.[1];
}

/** REQ-CONF-8: parameters for waitForWorkerReady's HTTP probe fallback (Step 2). Every value that could
 * otherwise be a fixed sleep is a parameter, so a unit test injects both `wait` and the probe and runs with no
 * real timers. */
export interface WaitForWorkerReadyOptions {
  /** The worker's URL, known up front from the row's own fixed --port (N6): every workerd-url row in rows.ts
   * carries one, so this is available before wrangler is even spawned. It is what the probe fallback polls
   * and what waitForWorkerReady returns when the probe, rather than the Ready line, wins the race. */
  url: string;
  /** Number of GET /counter attempts before the probe gives up; a 200 on any attempt ends the loop
   * immediately. */
  attempts: number;
  /** Delay between attempts, driven through `wait` rather than a bare setTimeout so a test can make it instant. */
  intervalMs: number;
  wait: (ms: number) => Promise<void>;
  /** Overall ceiling in ms; matches the collector's WRANGLER_READY_TIMEOUT_MS. */
  timeoutMs: number;
  context: string;
}

/**
 * REQ-CONF-8: resolves to the worker's URL from whichever readiness signal arrives first.
 *
 * The primary signal is wrangler dev's own "Ready on ..." line, read from `lines` chunk by chunk. The fallback
 * is a bounded HTTP probe of GET /counter, a route that bypasses the idempotency layer entirely (DEFAULT_METHODS
 * in packages/core/src/http/options.ts is ['POST', 'PATCH']), so it answers 200 the moment the worker itself is
 * listening, no key required. Both run concurrently from the start: a workerd-url row's port is fixed and known
 * before wrangler is even spawned (rows.ts assigns one to every such row), so there is no port announcement to
 * wait for before probing can begin; the Ready line is watched for its own sake because it is instant when it
 * comes. That is also why a probe that exhausts its attempts does not itself fail the wait: it only means the
 * Ready line, or the overall `timeoutMs` ceiling, decides instead.
 *
 * If `lines` ends before either signal fires, that is wrangler exiting (a port already bound, a bundle error),
 * and it is reported immediately with the output tail rather than waited out by an in-flight probe: an exited
 * process has nothing left to answer GET /counter.
 */
export async function waitForWorkerReady(
  lines: AsyncIterable<string>,
  probe: () => Promise<Response>,
  opts: WaitForWorkerReadyOptions,
): Promise<string> {
  const { url, attempts, intervalMs, wait, timeoutMs, context } = opts;
  const timer = rejectAfter(
    timeoutMs,
    `${context}: wrangler dev was not ready within ${timeoutMs} ms`,
  );

  async function watchReadyLine(): Promise<string> {
    let buffer = '';
    for await (const chunk of lines) {
      buffer += chunk;
      const found = parseReadyUrl(buffer);
      if (found !== undefined) return found;
    }
    throw new Error(`${context}: wrangler dev exited before it was ready: ${tail(buffer)}`);
  }

  async function watchProbe(): Promise<string> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await wait(intervalMs);
      try {
        const response = await probe();
        if (response.status === 200) return url;
      } catch {
        // Connection refused while workerd is still starting; keep retrying until attempts is spent.
      }
    }
    // Exhausted without a 200: never resolve or reject here. watchReadyLine may still succeed, wrangler may
    // exit (watchReadyLine's own rejection), or the timer will fire; a probe that gave up must not itself fail
    // a run that may still be legitimately starting.
    return new Promise<string>(() => {});
  }

  try {
    return await Promise.race([watchReadyLine(), watchProbe(), timer.promise]);
  } finally {
    timer.cancel();
  }
}

/** Adapts a stream reader into the AsyncIterable<string> waitForWorkerReady consumes, so the collector's real
 * ReadableStream and a unit test's plain async generator satisfy the same parameter. */
function chunksFrom(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        async next(): Promise<IteratorResult<string>> {
          const chunk = await reader.read();
          if (chunk.done) return { done: true, value: undefined };
          return { done: false, value: decoder.decode(chunk.value, { stream: true }) };
        },
      };
    },
  };
}

/** Keeps reading (and discarding) from `reader` until the stream ends, using the same reader rather than
 * releasing and reacquiring one. wrangler logs every request it serves once the run is under way, and a full
 * OS pipe buffer would stall the process mid-run whichever readiness path won. */
async function drainReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
  }
}

/**
 * REQ-CONF-8: wires waitForWorkerReady to wrangler dev's real stdout and a real GET /counter probe. `url` is
 * the row's own fixed --port (N6), already known by the caller before wrangler was spawned.
 */
async function waitForWranglerUrl(
  stream: ReadableStream<Uint8Array> | null,
  url: string,
  context: string,
): Promise<string> {
  if (stream === null) throw new Error(`${context}: wrangler dev produced no stdout`);
  const reader = stream.getReader();
  try {
    return await waitForWorkerReady(chunksFrom(reader), () => fetch(`${url}/counter`), {
      url,
      attempts: WRANGLER_PROBE_ATTEMPTS,
      intervalMs: WRANGLER_PROBE_INTERVAL_MS,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: WRANGLER_READY_TIMEOUT_MS,
      context,
    });
  } finally {
    void drainReader(reader).catch(() => {});
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
  const url = `http://127.0.0.1:${row.port}`;
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
  // stdout is drained by waitForWranglerUrl once readiness settles; stderr needs the same treatment for the
  // same reason. wrangler writes bundler and deprecation notices there, and a full OS pipe buffer would block
  // the process mid-run with nothing to time it out.
  void readAllText(wrangler.stderr).catch(() => {});
  try {
    const readyUrl = await waitForWranglerUrl(wrangler.stdout, url, `row "${row.id}" (${url})`);
    return await runTsConformanceCli(
      buildTsUrlArgs(row, readyUrl),
      `row "${row.id}" (${readyUrl})`,
    );
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
