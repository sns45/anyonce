#!/usr/bin/env bun
/**
 * REQ-CONF-8: collects every row in scripts/report/rows.ts, then either writes the committed
 * conformance/results/*.json and conformance/REPORT.md (--update), renders REPORT.md from what is already
 * committed with no target touched (--render-only), or diffs a fresh collection against what is committed and
 * exits 1 naming the first differing row.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import type { RunSummary } from '@anyonce/conformance';
import { collect, normalize, readResults, writeResults } from './report/collect';
import { renderReport } from './report/render';
import { type ReportRow, ROWS } from './report/rows';

const ROOT = join(import.meta.dir, '..');
const RESULTS_DIR = join(ROOT, 'conformance', 'results');
const REPORT_PATH = join(ROOT, 'conformance', 'REPORT.md');

interface Options {
  update: boolean;
  renderOnly: boolean;
  only: string[];
}

function parseArgs(args: string[]): Options {
  const options: Options = { update: false, renderOnly: false, only: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--update') {
      options.update = true;
    } else if (flag === '--render-only') {
      options.renderOnly = true;
    } else if (flag === '--only') {
      const value = args[i + 1];
      if (value === undefined) throw new Error('--only needs a value');
      options.only.push(value);
      i++;
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  return options;
}

function selectRows(options: Options): readonly ReportRow[] {
  if (options.only.length === 0) return ROWS;
  const wanted = new Set(options.only);
  return ROWS.filter((row) => wanted.has(row.id));
}

function missingResultsMessage(): string {
  return [
    `${RESULTS_DIR} does not exist yet.`,
    'Bring up both compose stacks and run a full collection first:',
    '  docker compose -f test/compose.yml up -d --wait',
    '  docker compose -f conformance/third-party/compose.yml up -d --wait --build',
    '  bun run report -- --update',
  ].join('\n');
}

function readCommittedReport(): string {
  return existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, 'utf8') : '';
}

function renderOnly(): number {
  if (!existsSync(RESULTS_DIR)) {
    console.error(missingResultsMessage());
    return 1;
  }
  const results = readResults(RESULTS_DIR);
  const missing = ROWS.filter((row) => !results.has(row.id));
  if (missing.length > 0) {
    console.error(
      `conformance/results/ is missing a committed result for: ${missing.map((row) => row.id).join(', ')}`,
    );
    return 1;
  }
  writeFileSync(REPORT_PATH, renderReport(ROWS, results));
  return 0;
}

async function collectFresh(rows: readonly ReportRow[]): Promise<Map<string, RunSummary>> {
  const fresh = new Map<string, RunSummary>();
  for (const row of rows) fresh.set(row.id, normalize(await collect(row)));
  return fresh;
}

async function update(rows: readonly ReportRow[]): Promise<number> {
  const fresh = await collectFresh(rows);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const merged = new Map(readResults(RESULTS_DIR));
  for (const [id, summary] of fresh) merged.set(id, summary);
  writeResults(RESULTS_DIR, merged);
  const missing = ROWS.filter((row) => !merged.has(row.id));
  if (missing.length === 0) writeFileSync(REPORT_PATH, renderReport(ROWS, merged));
  return 0;
}

function diffMessage(rowId: string, committed: RunSummary | undefined, fresh: RunSummary): string {
  return [
    `result for row "${rowId}" differs from the committed conformance/results/${rowId}.json`,
    '--- committed',
    committed === undefined ? '(missing)' : JSON.stringify(committed, null, 2),
    '+++ fresh',
    JSON.stringify(fresh, null, 2),
  ].join('\n');
}

async function checkDiff(rows: readonly ReportRow[]): Promise<number> {
  const fresh = await collectFresh(rows);
  const committed = existsSync(RESULTS_DIR)
    ? readResults(RESULTS_DIR)
    : new Map<string, RunSummary>();
  for (const row of rows) {
    const freshSummary = fresh.get(row.id);
    if (freshSummary === undefined) continue;
    const committedSummary = committed.get(row.id);
    if (JSON.stringify(committedSummary) !== JSON.stringify(freshSummary)) {
      console.error(diffMessage(row.id, committedSummary, freshSummary));
      return 1;
    }
  }
  const missing = ROWS.filter((row) => !committed.has(row.id));
  if (missing.length > 0) {
    console.error(`no committed result for: ${missing.map((row) => row.id).join(', ')}`);
    return 1;
  }
  const renderedFresh = renderReport(ROWS, committed);
  if (renderedFresh !== readCommittedReport()) {
    console.error(
      'conformance/REPORT.md does not match renderReport(ROWS, committed results); run "bun run report -- --update"',
    );
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  const options = parseArgs(argv.slice(2));
  if (options.renderOnly) return renderOnly();
  const rows = selectRows(options);
  if (options.update) return update(rows);
  return checkDiff(rows);
}

main().then(
  (code) => exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  },
);
