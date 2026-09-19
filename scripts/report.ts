#!/usr/bin/env bun
/**
 * REQ-CONF-8: collects every row in scripts/report/rows.ts, then either writes the committed
 * conformance/results/*.json and conformance/REPORT.md (--update), diffs a fresh render of the committed
 * results against the committed conformance/REPORT.md with no target touched and nothing written
 * (--render-only), or diffs a fresh collection against what is committed and exits 1 naming the first
 * differing row.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import type { RunSummary } from '@anyonce/conformance';
import {
  collect,
  normalize,
  pruneStaleResultFiles,
  readResults,
  writeResults,
} from './report/collect';
import { renderReport } from './report/render';
import { type ReportRow, ROWS } from './report/rows';

const ROOT = join(import.meta.dir, '..');
const RESULTS_DIR = join(ROOT, 'conformance', 'results');
const REPORT_PATH = join(ROOT, 'conformance', 'REPORT.md');

const USAGE =
  'usage: bun run report -- [--update] [--render-only] [--only <row-id>]...\n' +
  '  --update       collect every selected row and rewrite conformance/results/ and conformance/REPORT.md\n' +
  '  --render-only  render conformance/REPORT.md from the committed results and diff it; touches no target\n' +
  '  --only <id>    restrict to one row id, repeatable; default every row in scripts/report/rows.ts\n' +
  '  --help         show this message';

interface Options {
  update: boolean;
  renderOnly: boolean;
  only: string[];
}

/** Pure: exported so a test can check flag parsing without touching a file or a process. */
export function parseArgs(args: string[]): Options | string {
  const options: Options = { update: false, renderOnly: false, only: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return USAGE;
    if (flag === '--update') {
      options.update = true;
    } else if (flag === '--render-only') {
      options.renderOnly = true;
    } else if (flag === '--only') {
      const value = args[i + 1];
      if (value === undefined) return `--only needs a value\n${USAGE}`;
      options.only.push(value);
      i++;
    } else {
      return `unknown flag ${flag}\n${USAGE}`;
    }
  }
  return options;
}

/** B4: a usage error naming every unknown id and listing every valid one, rather than silently filtering
 * ROWS down to nothing. */
function validateRowIds(only: readonly string[]): string | undefined {
  const validIds = ROWS.map((row) => row.id);
  const unknown = only.filter((id) => !validIds.includes(id));
  if (unknown.length === 0) return undefined;
  return `unknown row id(s): ${unknown.join(', ')}\nvalid row ids: ${validIds.join(', ')}`;
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

function firstDifferingLine(committed: string, fresh: string): number {
  const committedLines = committed.split('\n');
  const freshLines = fresh.split('\n');
  const max = Math.max(committedLines.length, freshLines.length);
  for (let i = 0; i < max; i++) if (committedLines[i] !== freshLines[i]) return i;
  return max;
}

function reportDiffMessage(committed: string, fresh: string): string {
  const line = firstDifferingLine(committed, fresh);
  const committedLine = committed.split('\n')[line] ?? '(end of file)';
  const freshLine = fresh.split('\n')[line] ?? '(end of file)';
  return [
    'conformance/REPORT.md does not match renderReport(ROWS, committed results); run "bun run report -- --update"',
    `first differing line ${line + 1}:`,
    `--- committed: ${committedLine}`,
    `+++ fresh:     ${freshLine}`,
  ].join('\n');
}

/** B3: renders from the committed results and diffs against the committed conformance/REPORT.md. Never
 * writes; a mismatch is a failure, not something this mode silently repairs. */
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
  const rendered = renderReport(ROWS, results);
  const committed = readCommittedReport();
  if (rendered !== committed) {
    console.error(reportDiffMessage(committed, rendered));
    return 1;
  }
  console.log(
    `render-only: conformance/REPORT.md matches the committed results for all ${ROWS.length} rows`,
  );
  return 0;
}

async function collectFresh(rows: readonly ReportRow[]): Promise<Map<string, RunSummary>> {
  const fresh = new Map<string, RunSummary>();
  for (const row of rows) fresh.set(row.id, normalize(await collect(row)));
  return fresh;
}

/** N12: fails loudly (exit 1, no REPORT.md write) when a row this run did not collect still has no committed
 * result, and prunes any conformance/results/<id>.json whose id is no longer in ROWS instead of leaving it to
 * rot on disk or resurrecting it by rewriting it unchanged. */
async function update(rows: readonly ReportRow[]): Promise<number> {
  const fresh = await collectFresh(rows);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const merged = new Map(readResults(RESULTS_DIR));
  for (const [id, summary] of fresh) merged.set(id, summary);
  const rowIds = new Set(ROWS.map((row) => row.id));
  for (const id of [...merged.keys()]) if (!rowIds.has(id)) merged.delete(id);
  writeResults(RESULTS_DIR, merged);
  const removed = pruneStaleResultFiles(RESULTS_DIR, rowIds);
  if (removed.length > 0)
    console.log(`removed stale result file(s) with no matching row: ${removed.join(', ')}`);
  const missing = ROWS.filter((row) => !merged.has(row.id));
  if (missing.length > 0) {
    console.error(
      `updated ${merged.size} of ${ROWS.length} result file(s); conformance/REPORT.md was not regenerated ` +
        `because these rows have no committed result yet: ${missing.map((row) => row.id).join(', ')}`,
    );
    return 1;
  }
  writeFileSync(REPORT_PATH, renderReport(ROWS, merged));
  console.log(
    `updated conformance/results/ and conformance/REPORT.md; collected ${rows.length} of ${ROWS.length} ` +
      `row(s) this run: ${rows.map((row) => row.id).join(', ')}`,
  );
  return 0;
}

/** N5: a committed conformance/results/<id>.json whose id is not in ROWS is an error naming the file, the
 * mirror image of every ROWS row needing a committed result. */
function findOrphanResultFiles(committed: ReadonlyMap<string, RunSummary>): string[] {
  const rowIds = new Set(ROWS.map((row) => row.id));
  return [...committed.keys()].filter((id) => !rowIds.has(id)).map((id) => `${id}.json`);
}

async function checkDiff(rows: readonly ReportRow[]): Promise<number> {
  const fresh = await collectFresh(rows);
  const committed = existsSync(RESULTS_DIR)
    ? readResults(RESULTS_DIR)
    : new Map<string, RunSummary>();

  const orphans = findOrphanResultFiles(committed);
  if (orphans.length > 0) {
    console.error(
      `conformance/results/ has a committed file with no matching row in scripts/report/rows.ts: ${orphans.join(', ')}`,
    );
    return 1;
  }

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
  const committedReport = readCommittedReport();
  if (renderedFresh !== committedReport) {
    console.error(reportDiffMessage(committedReport, renderedFresh));
    return 1;
  }
  console.log(
    `verified ${rows.length} of ${ROWS.length} row(s): ${rows.map((row) => row.id).join(', ')}`,
  );
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

async function main(): Promise<number> {
  const parsed = parseArgs(argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 2;
  }
  const idsError = validateRowIds(parsed.only);
  if (idsError !== undefined) {
    console.error(idsError);
    return 2;
  }
  if (parsed.renderOnly) return renderOnly();
  const rows = selectRows(parsed);
  if (parsed.update) return update(rows);
  return checkDiff(rows);
}

main().then(
  (code) => exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  },
);
