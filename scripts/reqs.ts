#!/usr/bin/env bun
/**
 * REQ coverage check (requirements.md section 7 item 1).
 * Every REQ and NFR id in scope must have at least one test whose name starts with the id.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ID_PATTERN = /\b((?:REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)|(?:NFR-\d+))\b/;
const DEFINITION = /\*\*((?:REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)|(?:NFR-\d+))\*\*/g;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', '.wrangler', 'coverage']);
// reqs.test.ts exercises this script's own id-collection logic against synthetic fixture sources that
// contain real REQ ids inside string literals (for example 'REQ-CONF-1: validates'), so scanning it as a
// source file would report those ids as covered by a fixture rather than by a real test. Every other file
// under scripts/, including scripts/report.test.ts, is scanned normally.
const SKIP_FILES = new Set(['scripts/reqs.test.ts']);

export function parseDefinedIds(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(DEFINITION)) {
    const id = match[1] as string;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Expands one cell of the section 6 REQs column, for example "CONF-1..4, REL-4" or "ST-*" or "NFR-*". */
export function expandScope(spec: string, defined: string[]): string[] {
  const out: string[] = [];
  for (const raw of spec.split(',')) {
    const token = raw.trim();
    if (token === '') continue;
    const prefix = token.startsWith('NFR-') ? '' : 'REQ-';
    const wildcard = /^([A-Z0-9-]+)-\*$/.exec(token);
    if (wildcard) {
      const area = `${prefix}${wildcard[1]}-`;
      for (const id of defined) if (id.startsWith(area)) out.push(id);
      continue;
    }
    const range = /^([A-Z0-9-]+)-(\d+)\.\.(\d+)$/.exec(token);
    if (range) {
      for (let n = Number(range[2]); n <= Number(range[3]); n++) {
        const id = `${prefix}${range[1]}-${n}`;
        if (defined.includes(id)) out.push(id);
      }
      continue;
    }
    const single = /^([A-Z0-9-]+)-(\d+)$/.exec(token);
    if (single) {
      const id = `${prefix}${single[1]}-${single[2]}`;
      if (defined.includes(id)) out.push(id);
    }
  }
  return out;
}

export function parsePhaseScopes(text: string, defined: string[]): Map<string, string[]> {
  const scopes = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const row = /^\|\s*(P\d[a-z]?)\b[^|]*\|[^|]*\|([^|]*)\|/.exec(line);
    if (!row) continue;
    scopes.set((row[1] as string).toLowerCase(), expandScope(row[2] as string, defined));
  }
  return scopes;
}

/** Parses the section 6 table's fourth "Depends on" column into direct phase dependencies. */
export function parsePhaseDeps(text: string): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const row = /^\|\s*(P\d[a-z]?)\b[^|]*\|[^|]*\|[^|]*\|([^|]*)\|/.exec(line);
    if (!row) continue;
    const cell = (row[2] as string).trim();
    const list =
      cell === '' || cell.toLowerCase() === 'none'
        ? []
        : cell
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s !== '');
    deps.set((row[1] as string).toLowerCase(), list);
  }
  return deps;
}

/** Returns the phase's own ids plus the transitive closure of its dependencies' ids, de-duplicated, in table order. */
export function phaseScope(
  phase: string,
  scopes: Map<string, string[]>,
  deps: Map<string, string[]>,
): string[] {
  const seenPhases = new Set<string>();
  const out: string[] = [];
  const seenIds = new Set<string>();

  function visit(p: string): void {
    if (seenPhases.has(p)) return;
    seenPhases.add(p);
    for (const dep of deps.get(p) ?? []) visit(dep);
    for (const id of scopes.get(p) ?? []) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        out.push(id);
      }
    }
  }

  visit(phase);
  return out;
}

function walk(dir: string, out: string[], root?: string): void {
  if (!root) root = dir;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(root, full);
    // Matched on the path rather than the basename, so a file of the same name elsewhere is still scanned.
    if (SKIP_FILES.has(rel)) continue;
    const pathSegments = rel.split('/');
    if (statSync(full).isDirectory()) walk(full, out, root);
    else if (
      name.endsWith('.test.ts') ||
      name.endsWith('_test.go') ||
      // Contract suites register tests from library code in testing/ and storetest/ directories.
      pathSegments.some((seg) => seg === 'testing' || seg === 'storetest')
    )
      out.push(full);
  }
}

function idsInTsSource(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/['"`]((?:REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)|(?:NFR-\d+)):/g))
    out.push(match[1] as string);
  return out;
}

function idsInGoSource(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/"((?:REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)|(?:NFR-\d+)):/g))
    out.push(match[1] as string);
  for (const match of source.matchAll(
    /func Test((?:REQ_[A-Z0-9]+(?:_[A-Z0-9]+)*_\d+)|(?:NFR_\d+))/g,
  )) {
    out.push((match[1] as string).replace(/_/g, '-'));
  }
  return out;
}

export function collectTestIds(root: string): Map<string, string[]> {
  const files: string[] = [];
  walk(root, files);
  const found = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const ids = file.endsWith('.go') ? idsInGoSource(source) : idsInTsSource(source);
    for (const id of ids) {
      const list = found.get(id) ?? [];
      list.push(relative(root, file));
      found.set(id, list);
    }
  }
  return found;
}

export interface CoverageReport {
  ok: boolean;
  uncovered: string[];
  unknown: string[];
  covered: Array<{ id: string; tests: number }>;
}

export function coverageReport(
  defined: string[],
  scoped: string[],
  found: Map<string, string[]>,
): CoverageReport {
  const uncovered = scoped.filter((id) => !found.has(id));
  const unknown = [...found.keys()]
    .filter((id) => !defined.includes(id) && ID_PATTERN.test(id))
    .sort();
  const covered = scoped
    .filter((id) => found.has(id))
    .map((id) => ({ id, tests: (found.get(id) ?? []).length }));
  return { ok: uncovered.length === 0 && unknown.length === 0, uncovered, unknown, covered };
}

function main(argv: string[]): number {
  const root = join(import.meta.dir, '..');
  const text = readFileSync(join(root, 'requirements.md'), 'utf8');
  const defined = parseDefinedIds(text);
  const scopes = parsePhaseScopes(text, defined);
  const deps = parsePhaseDeps(text);
  const phaseArg = argv.indexOf('--phase');
  let scoped: string[];
  if (argv.includes('--all')) {
    scoped = defined;
  } else if (phaseArg >= 0) {
    const target = (argv[phaseArg + 1] ?? '').toLowerCase();
    if (!scopes.has(target)) {
      console.error(`unknown phase: ${target || '(none given)'}`);
      return 2;
    }
    scoped = phaseScope(target, scopes, deps);
  } else {
    console.error('usage: bun run scripts/reqs.ts --phase p0 | --all');
    return 2;
  }
  const report = coverageReport(defined, scoped, collectTestIds(root));
  for (const row of report.covered) console.log(`${row.id.padEnd(18)} ${row.tests} test(s)`);
  if (report.uncovered.length > 0) console.error(`\nUNCOVERED: ${report.uncovered.join(', ')}`);
  if (report.unknown.length > 0)
    console.error(`\nUNKNOWN ids referenced by tests: ${report.unknown.join(', ')}`);
  console.log(`\n${report.covered.length}/${scoped.length} in-scope ids covered`);
  return report.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
