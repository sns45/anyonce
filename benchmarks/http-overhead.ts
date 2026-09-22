#!/usr/bin/env bun
/**
 * NFR-1: benchmarks how much the HTTP adapter (withIdempotency, packages/core/src/http) adds over a bare
 * fetch-shaped handler when the store is MemoryStore, in one process, one runtime (docs/superpowers/
 * questions.md Q63). Two paths are measured against the same bare baseline: first execution (a fresh
 * Idempotency-Key on every call, so every call is a first begin) and replay (one fixed key, so every
 * measured call replays the result the priming call stored). Overhead is the wrapped path's p50 minus the
 * bare handler's p50. `bun run bench` runs this file directly and rewrites the bench block in README.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, type as osType, release } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '@anyonce/core';
import { withIdempotency } from '@anyonce/core/http';

export interface Stats {
  p50Ms: number;
  p99Ms: number;
}

export interface BenchResult {
  bare: Stats;
  firstExecution: Stats;
  replay: Stats;
  overheadP50Ms: { firstExecution: number; replay: number };
  runtime: string;
  iterations: number;
}

const START_MARKER = '<!-- bench:start -->';
const END_MARKER = '<!-- bench:end -->';

const REQUEST_BODY = JSON.stringify({ item: 'book' });

/** The trivial handler both the bare path and the wrapped path call. It reads the body, like a real handler. */
async function handler(req: Request): Promise<Response> {
  await req.text();
  return new Response(REQUEST_BODY, {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fresh Request with a fresh body every call; Bun refuses a consumed one. */
function makeRequest(key?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return new Request('http://localhost/orders', { method: 'POST', headers, body: REQUEST_BODY });
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function toStats(times: readonly number[]): Stats {
  const sorted = [...times].sort((a, b) => a - b);
  return { p50Ms: percentile(sorted, 50), p99Ms: percentile(sorted, 99) };
}

/** Sequential awaits, timed one at a time with performance.now() around each call. */
async function timeCalls(n: number, run: () => Promise<Response>): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return times;
}

/**
 * NFR-1 (Q63): runs the bare handler, the first-execution path and the replay path sequentially in this
 * process, `iterations` times each after `warmup` throwaway iterations of each that are not timed.
 */
export async function measure(opts: { iterations: number; warmup: number }): Promise<BenchResult> {
  const { iterations, warmup } = opts;

  const runBare = (): Promise<Response> => handler(makeRequest());

  let firstCounter = 0;
  const firstStore = new MemoryStore();
  const firstWrapped = withIdempotency(handler, { store: firstStore });
  const runFirst = (): Promise<Response> => {
    firstCounter += 1;
    return firstWrapped(makeRequest(`bench-first-${firstCounter}`));
  };

  const replayStore = new MemoryStore();
  const replayWrapped = withIdempotency(handler, { store: replayStore });
  const runReplay = (): Promise<Response> => replayWrapped(makeRequest('bench-replay'));

  // Primes the replay record once, outside every timed and warmup call, so every one of those is a real replay.
  await runReplay();

  for (let i = 0; i < warmup; i++) await runBare();
  for (let i = 0; i < warmup; i++) await runFirst();
  for (let i = 0; i < warmup; i++) await runReplay();

  const bare = toStats(await timeCalls(iterations, runBare));
  const firstExecution = toStats(await timeCalls(iterations, runFirst));
  const replay = toStats(await timeCalls(iterations, runReplay));

  return {
    bare,
    firstExecution,
    replay,
    overheadP50Ms: {
      firstExecution: firstExecution.p50Ms - bare.p50Ms,
      replay: replay.p50Ms - bare.p50Ms,
    },
    runtime: `Bun ${Bun.version}`,
    iterations,
  };
}

function row(label: string, bare: Stats, wrapped: Stats, overheadP50: number): string {
  const cell = (n: number): string => n.toFixed(3);
  return `| ${label} | ${cell(bare.p50Ms)} | ${cell(wrapped.p50Ms)} | ${cell(overheadP50)} | ${cell(wrapped.p99Ms)} |`;
}

/**
 * NFR-1 (Q63): a plain markdown table (path, bare p50, wrapped p50, overhead p50, wrapped p99) plus a line
 * naming the runtime, the machine and the iteration count. No em or en dash, no key.
 */
export function renderBenchBlock(r: BenchResult, machine: string): string {
  return [
    '| Path | Bare p50 (ms) | Wrapped p50 (ms) | Overhead p50 (ms) | Wrapped p99 (ms) |',
    '| --- | --- | --- | --- | --- |',
    row('first execution', r.bare, r.firstExecution, r.overheadP50Ms.firstExecution),
    row('replay', r.bare, r.replay, r.overheadP50Ms.replay),
    '',
    `Measured on ${r.runtime}, ${machine}, ${r.iterations} iterations per path.`,
  ].join('\n');
}

/** Replaces only the text between the bench markers (Task 6); throws if either marker is missing or reversed. */
export function writeReadme(readme: string, block: string): string {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('README.md is missing the bench:start or bench:end marker');
  }
  const before = readme.slice(0, start + START_MARKER.length);
  const after = readme.slice(end);
  return `${before}\n${block}\n${after}`;
}

async function main(): Promise<void> {
  const result = await measure({ iterations: 20_000, warmup: 2_000 });
  const cpu = cpus()[0];
  const machine = `${osType()} ${release()}, ${cpu?.model ?? 'unknown CPU'}`;
  const block = renderBenchBlock(result, machine);
  const readmePath = join(import.meta.dir, '..', 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  writeFileSync(readmePath, writeReadme(readme, block));
  console.log(
    `benchmarks/http-overhead.ts: wrote ${result.iterations} iterations per path to README.md`,
  );
}

if (import.meta.main) {
  await main();
}
