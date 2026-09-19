/**
 * REQ-CONF-8: one collector per RowKind, plus normalize/readResults/writeResults for the committed golden
 * files under conformance/results/. No collector here is invoked by scripts/report.test.ts (Task 4); they run
 * for real from scripts/report.ts, which needs the compose stacks up.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary } from '@anyonce/conformance';
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
import type { ReportRow } from './rows';
import { GO_REGRADED_VECTOR_ID } from './rows';

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

/**
 * REQ-CONF-8: strips anything not in the RunSummary shape (in particular the CLI's `target` and
 * `generatedAt`) and sorts `results` by id so the committed JSON is deterministic.
 */
export function normalize(summary: RunSummary): RunSummary {
  const results = [...summary.results].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
 * exactly as packages/stores/services/*.conformance.test.ts do.
 */
export async function collectTsInProcess(row: ReportRow): Promise<RunSummary> {
  const { store, cleanup } = await buildStore(row.store);
  try {
    const handler = withIdempotency(createFixtureApp().fetch, {
      store,
      required: true,
      ttlMs: 2000,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    const { summary } = await runConformance({
      target: handler,
      capabilities: ['short-ttl'],
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

/** Runs go/cmd/conformance against a running URL and parses its JSON report. */
async function runGoConformanceCli(args: readonly string[]): Promise<RunSummary> {
  const proc = Bun.spawn({
    cmd: ['go', 'run', './cmd/conformance', ...args, '-report', 'json'],
    cwd: GO_ROOT,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await readAllText(proc.stdout);
  const code = await proc.exited;
  if (code !== 0 && code !== 1) throw new Error(`go run ./cmd/conformance exited ${code}`);
  return JSON.parse(output) as RunSummary;
}

/** REQ-CONF-8: the anyonce Go rows. Starts go/cmd/fixture with -idempotent -store <name>, drives it with
 * go/cmd/conformance, then stops the fixture. */
export async function collectGoUrl(row: ReportRow): Promise<RunSummary> {
  const fixture = Bun.spawn({
    cmd: ['go', 'run', './cmd/fixture', '-idempotent', '-store', row.store, '-ttl-ms', '2000'],
    cwd: GO_ROOT,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  try {
    const url = await waitForListeningUrl(fixture.stdout);
    return await runGoConformanceCli(['-url', url, '-ttl-ms', '2000', '-capability', 'short-ttl']);
  } finally {
    fixture.kill();
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

/** Shells out to the TypeScript CLI with --report json, then splices in the Go runner's result for
 * core/header-name-case-insensitive (Q52), which the Fetch Headers class cannot discriminate. */
export async function collectTsUrl(row: ReportRow): Promise<RunSummary> {
  const url = thirdPartyUrl(row);
  const proc = Bun.spawn({
    cmd: ['bun', 'run', CONFORMANCE_CLI, '--url', url, '--report', 'json'],
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await readAllText(proc.stdout);
  const code = await proc.exited;
  if (code !== 0 && code !== 1)
    throw new Error(`the conformance CLI exited ${code} against ${url}`);
  const tsSummary = JSON.parse(output) as RunSummary;

  const goSummary = await runGoConformanceCli(['-url', url, '-only', GO_REGRADED_VECTOR_ID]);
  const goResult = goSummary.results.find((r) => r.id === GO_REGRADED_VECTOR_ID);
  if (goResult === undefined) {
    throw new Error(`go run ./cmd/conformance -only ${GO_REGRADED_VECTOR_ID} produced no result`);
  }
  const results = tsSummary.results.map((r) => (r.id === GO_REGRADED_VECTOR_ID ? goResult : r));
  return {
    results,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    notApplicable: results.filter((r) => r.status === 'not-applicable').length,
    errored: results.filter((r) => r.status === 'error').length,
  };
}

/** REQ-CONF-8 / Task 5: Durable Objects and D1 run inside workerd via wrangler dev, which this task does not
 * build. Left as a clear placeholder rather than a silent stub. */
export function collectWorkerdUrl(row: ReportRow): Promise<RunSummary> {
  return Promise.reject(
    new Error(
      `the workerd-url collector for "${row.id}" is not implemented in this task, see Task 5`,
    ),
  );
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
