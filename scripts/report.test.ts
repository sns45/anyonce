import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary, VectorResult, VectorStatus } from '@anyonce/conformance';
import { capabilityArgs, normalize, readResults } from './report/collect';
import { renderReport } from './report/render';
import { CAPABILITY_TTL_MS, type ReportRow, ROWS } from './report/rows';

const ROOT = join(import.meta.dir, '..');
const RESULTS_DIR = join(ROOT, 'conformance', 'results');
const REPORT_PATH = join(ROOT, 'conformance', 'REPORT.md');
const ISSUES_DIR = join(ROOT, 'conformance', 'issues');
const VECTORS_DIR = join(ROOT, 'conformance', 'vectors');
const DRAFT_GAPS_PATH = join(ROOT, 'conformance', 'DRAFT-GAPS.md');

const THIRD_PARTY_IDS = new Set(['hono-idempotency', 'idempo', 'fiber']);
const IMAGE_TAG = /:\d+\.\d+\.\d+[\w.-]*$/;
const EXACT_VERSION = /^v?\d+\.\d+\.\d+/;
const EM_OR_EN_DASH = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)];

/** A minimal, valid ReportRow for tests that don't care about the manifest's real content. */
function testRow(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: 'row-x',
    implementation: 'Row X',
    version: '1.0.0',
    language: 'TypeScript',
    store: 'memory',
    kind: 'ts-in-process',
    fixturePath: 'conformance/fixtures/hono (in-process)',
    graded: ['core', 'profile'],
    capabilities: ['short-ttl'],
    ...overrides,
  };
}

function vectorResult(
  id: string,
  tier: 'core' | 'profile',
  status: VectorStatus,
  error?: string,
): VectorResult {
  const base: VectorResult = { id, tier, status, steps: [] };
  return error === undefined ? base : { ...base, error };
}

function summaryOf(results: VectorResult[]): RunSummary {
  return {
    results,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    notApplicable: results.filter((r) => r.status === 'not-applicable').length,
    errored: results.filter((r) => r.status === 'error').length,
  };
}

function containsAny(text: string, chars: readonly string[]): boolean {
  return chars.some((ch) => text.includes(ch));
}

function readVectorIds(): string[] {
  const ids: string[] = [];
  for (const tier of readdirSync(VECTORS_DIR)) {
    const tierDir = join(VECTORS_DIR, tier);
    for (const file of readdirSync(tierDir)) {
      if (!file.endsWith('.json')) continue;
      const vector = JSON.parse(readFileSync(join(tierDir, file), 'utf8')) as { id: string };
      ids.push(vector.id);
    }
  }
  return ids;
}

describe('scripts/report', () => {
  test('REQ-CONF-8: every manifest row has a unique id', () => {
    const ids = ROWS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(14);
  });

  test('REQ-CONF-8: a third-party row is graded on core only and an anyonce row on both tiers', () => {
    for (const row of ROWS) {
      if (THIRD_PARTY_IDS.has(row.id)) expect(row.graded).toEqual(['core']);
      else expect(row.graded).toEqual(['core', 'profile']);
    }
  });

  test('REQ-CONF-8: a container row names a pinned image tag and pinned package versions', () => {
    const containerRows = ROWS.filter((row) => row.image !== undefined);
    expect(containerRows.length).toBe(3);
    for (const row of containerRows) {
      expect(row.image ?? '').toMatch(IMAGE_TAG);
      expect(row.packages).toBeDefined();
      for (const pkg of row.packages ?? []) {
        const version = pkg.slice(pkg.lastIndexOf('@') + 1);
        expect(version).toMatch(EXACT_VERSION);
      }
    }
  });

  test('REQ-CONF-8: renderReport gives every row one matrix line with core, profile and not-applicable counts', () => {
    const rows: ReportRow[] = [
      testRow({
        id: 'row-a',
        implementation: 'Row A',
        version: '1.0.0',
        language: 'TypeScript',
        kind: 'ts-in-process',
      }),
      testRow({
        id: 'row-b',
        implementation: 'Row B',
        version: '2.0.0',
        language: 'Go',
        kind: 'go-url',
      }),
    ];
    const results = new Map<string, RunSummary>([
      [
        'row-a',
        summaryOf([
          vectorResult('core/post-executes-once', 'core', 'pass'),
          vectorResult('core/get-ignored', 'core', 'fail'),
          vectorResult('profile/replayed-header', 'profile', 'pass'),
          vectorResult(
            'core/expiry-executes-again',
            'core',
            'not-applicable',
            'requires short-ttl',
          ),
        ]),
      ],
      ['row-b', summaryOf([vectorResult('core/post-executes-once', 'core', 'pass')])],
    ]);
    const output = renderReport(rows, results);
    const lines = output.split('\n').filter((line) => line.startsWith('| Row '));
    expect(lines).toEqual([
      '| Row A | 1.0.0 | TypeScript | memory | 1/11 | 1/9 | 1 | ' +
        'core/concurrent-409 (missing), [core/get-ignored](issues/row-a-get-ignored.md), ' +
        'core/header-name-case-insensitive (missing), core/key-missing-required (missing), ' +
        'core/mismatch-422 (missing), core/mismatch-does-not-poison (missing), ' +
        'core/retry-replays (missing), core/sf-string-quoted-key (missing), ' +
        'core/two-keys-execute-twice (missing) |',
      '| Row B | 2.0.0 | Go | memory | 1/11 | 0/9 | 0 | ' +
        'core/concurrent-409 (missing), core/expiry-executes-again (missing), ' +
        'core/get-ignored (missing), core/header-name-case-insensitive (missing), ' +
        'core/key-missing-required (missing), core/mismatch-422 (missing), ' +
        'core/mismatch-does-not-poison (missing), core/retry-replays (missing), ' +
        'core/sf-string-quoted-key (missing), core/two-keys-execute-twice (missing) |',
    ]);
  });

  // B2: the numerator is computed by walking the catalog and looking each id up, never by filtering
  // summary.results directly, so a stale result carrying a duplicated or off-catalog vector id can never push
  // a count past the catalog's own denominator.
  test('REQ-CONF-8: a duplicated or off-catalog result id never inflates a matrix count', () => {
    const row = testRow({ id: 'acme' });
    const results = new Map<string, RunSummary>([
      [
        'acme',
        summaryOf([
          vectorResult('core/post-executes-once', 'core', 'pass'),
          vectorResult('core/post-executes-once', 'core', 'pass'),
          vectorResult('core/not-a-real-vector', 'core', 'pass'),
        ]),
      ],
    ]);
    const output = renderReport([row], results);
    expect(output).toContain('| Row X | 1.0.0 | TypeScript | memory | 1/11 |');
  });

  test('REQ-CONF-8: a failing core vector renders as a link to its issue draft', () => {
    const row = testRow({ id: 'acme', implementation: 'Acme', kind: 'ts-url', graded: ['core'] });
    const results = new Map<string, RunSummary>([
      ['acme', summaryOf([vectorResult('core/mismatch-422', 'core', 'fail')])],
    ]);
    const output = renderReport([row], results);
    expect(output).toContain('[core/mismatch-422](issues/acme-mismatch-422.md)');
  });

  // N11: a core vector with no result at all (never reported, not merely failed) is named as missing rather
  // than silently omitted from the failing-core cell, and for every row, not only rows with a per-vector table.
  test('REQ-CONF-8: a core vector missing from the results entirely renders as missing, not as a pass', () => {
    const row = testRow({ id: 'acme', graded: ['core', 'profile'] });
    const allButOne = [
      'core/concurrent-409',
      'core/get-ignored',
      'core/header-name-case-insensitive',
      'core/key-missing-required',
      'core/mismatch-422',
      'core/mismatch-does-not-poison',
      'core/post-executes-once',
      'core/retry-replays',
      'core/sf-string-quoted-key',
      'core/two-keys-execute-twice',
    ];
    const results = new Map<string, RunSummary>([
      ['acme', summaryOf(allButOne.map((id) => vectorResult(id, 'core', 'pass')))],
    ]);
    const output = renderReport([row], results);
    expect(output).toContain('| Row X | 1.0.0 | TypeScript | memory | 10/11 |');
    expect(output).toContain('core/expiry-executes-again (missing)');
    expect(output).not.toContain('[core/expiry-executes-again]');
  });

  test("REQ-CONF-8: a third-party row's profile count is marked as information", () => {
    const thirdParty = testRow({
      id: 'acme',
      implementation: 'Acme',
      kind: 'ts-url',
      graded: ['core'],
    });
    const anyonce: ReportRow = { ...thirdParty, id: 'anyonce-x', graded: ['core', 'profile'] };
    const results = new Map<string, RunSummary>([
      ['acme', summaryOf([vectorResult('profile/replayed-header', 'profile', 'pass')])],
      ['anyonce-x', summaryOf([vectorResult('profile/replayed-header', 'profile', 'pass')])],
    ]);
    const output = renderReport([thirdParty, anyonce], results);
    expect(output).toContain('| Acme | 1.0.0 | TypeScript | memory | 0/11 | 1/9 (info) | 0 |');
    expect(output).toContain('| Acme | 1.0.0 | TypeScript | memory | 0/11 | 1/9 | 0 |');
  });

  // N10: the Targets section names the fixture path from the manifest rather than deriving it by string
  // surgery on the row id.
  test('REQ-CONF-8: renderReport names each row fixture path in the Targets section', () => {
    const row = testRow({ id: 'acme', fixturePath: 'conformance/third-party/acme/' });
    const output = renderReport([row], new Map([['acme', summaryOf([])]]));
    expect(output).toContain('- Fixture: conformance/third-party/acme/');
  });

  test('REQ-CONF-8: renderReport is deterministic and emits no timestamp', () => {
    const results = new Map<string, RunSummary>(ROWS.map((row) => [row.id, summaryOf([])]));
    const first = renderReport(ROWS, results);
    const second = renderReport(ROWS, results);
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  test('REQ-CONF-8: renderReport emits no em or en dash', () => {
    const results = new Map<string, RunSummary>(ROWS.map((row) => [row.id, summaryOf([])]));
    const output = renderReport(ROWS, results);
    expect(containsAny(output, EM_OR_EN_DASH)).toBe(false);
  });

  test('REQ-CONF-8: normalize sorts results by id and drops the report metadata', () => {
    const withMetadata = {
      target: 'http://example.invalid',
      generatedAt: '2020-01-01T00:00:00.000Z',
      results: [
        vectorResult('core/two-keys-execute-twice', 'core', 'pass'),
        vectorResult('core/get-ignored', 'core', 'pass'),
      ],
      passed: 2,
      failed: 0,
      notApplicable: 0,
      errored: 0,
    } as unknown as RunSummary;
    const normalized = normalize(withMetadata);
    expect(normalized.results.map((r) => r.id)).toEqual([
      'core/get-ignored',
      'core/two-keys-execute-twice',
    ]);
    expect(Object.keys(normalized).sort()).toEqual(
      ['errored', 'failed', 'notApplicable', 'passed', 'results'].sort(),
    );
  });

  // N6: a connection error against an ephemeral or fixed port must never land verbatim in a committed
  // result, since a byte diff on the next run would then depend on which port happened to be free.
  test('REQ-CONF-8: normalize redacts 127.0.0.1:<port> in error and failure strings', () => {
    const withPorts: RunSummary = {
      results: [
        {
          id: 'core/post-executes-once',
          tier: 'core',
          status: 'error',
          steps: [{ stepId: 'first', failures: ['connect to 127.0.0.1:54321 refused'] }],
          error: 'dial tcp 127.0.0.1:54321: connect: connection refused',
        },
      ],
      passed: 0,
      failed: 0,
      notApplicable: 0,
      errored: 1,
    };
    const normalized = normalize(withPorts);
    const result = normalized.results[0];
    expect(result?.error).toBe('dial tcp 127.0.0.1:PORT: connect: connection refused');
    expect(result?.steps[0]?.failures[0]).toBe('connect to 127.0.0.1:PORT refused');
  });

  // N9 (subsumes B1): every collector is driven by row.capabilities rather than a hardcoded string, so a row
  // declaring short-ttl always asks its runner for it, with a matching --ttl-ms / -ttl-ms.
  // conformance/report/worker/index.ts runs inside workerd and cannot import CAPABILITY_TTL_MS from
  // scripts/, which pulls in node: builtins, so it repeats the number as a literal. If the two ever drift
  // apart the workerd rows grade core/expiry-executes-again against a TTL the target does not have, and
  // nothing else would notice. Read the literal back out of the worker source rather than trusting a comment.
  test('REQ-CONF-8: the workerd target is configured with the TTL the short-ttl capability grades', () => {
    const worker = readFileSync(join(ROOT, 'conformance', 'report', 'worker', 'index.ts'), 'utf8');
    const match = /const TTL_MS = (\d+);/.exec(worker);
    expect(
      match?.[1],
      'conformance/report/worker/index.ts must declare a TTL_MS literal',
    ).toBeDefined();
    expect(Number(match?.[1])).toBe(CAPABILITY_TTL_MS);
  });

  test('REQ-CONF-8: every row declaring short-ttl produces a CLI argument list containing it', () => {
    const shortTtlRows = ROWS.filter((row) => row.capabilities.includes('short-ttl'));
    expect(shortTtlRows.length).toBeGreaterThan(0);
    for (const row of shortTtlRows) {
      const tsArgs = capabilityArgs(row.capabilities, '--');
      expect(tsArgs).toContain('--capability');
      expect(tsArgs).toContain('short-ttl');
      expect(tsArgs).toContain('--ttl-ms');
      const goArgs = capabilityArgs(row.capabilities, '-');
      expect(goArgs).toContain('-capability');
      expect(goArgs).toContain('short-ttl');
      expect(goArgs).toContain('-ttl-ms');
    }
    expect(capabilityArgs([], '--')).toEqual([]);
  });

  // REQ-CONF-9: this test can run today and would fail today, since DRAFT-GAPS.md only has G1 to G3 (Task 7
  // adds G4 to G17). Written now with its final name and body so Task 7 only has to remove `.todo`.
  test.todo('REQ-CONF-9: every vector id appears in at least one DRAFT-GAPS entry', () => {
    const ids = readVectorIds();
    const gaps = readFileSync(DRAFT_GAPS_PATH, 'utf8');
    const missing = ids.filter((id) => !gaps.includes(id));
    expect(missing).toEqual([]);
  });

  // REQ-CONF-9: same story as above; G1 to G3 already fit this shape, but the requirement is over every entry,
  // so it is written now and flipped in Task 7 alongside the coverage test above.
  test.todo('REQ-CONF-9: every DRAFT-GAPS entry has a draft section, an anyonce choice, proposed draft text and a status', () => {
    const gaps = readFileSync(DRAFT_GAPS_PATH, 'utf8');
    const entries = gaps.split(/\n(?=### G\d+)/).filter((block) => block.startsWith('### G'));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatch(/Draft section:/);
      expect(entry).toMatch(/anyonce choice:/);
      expect(entry).toMatch(/Proposed draft text:/);
      expect(entry).toMatch(/Status: open/);
    }
  });

  // The following six tests read conformance/results/*.json and conformance/REPORT.md, which Task 6 produces.
  // Bodies are written now so Task 6 only has to remove `.todo`.

  test('REQ-CONF-8: every manifest row has a committed result', () => {
    const results = readResults(RESULTS_DIR);
    for (const row of ROWS) expect(results.has(row.id)).toBe(true);
  });

  test('REQ-CONF-8: every committed result belongs to a manifest row', () => {
    const results = readResults(RESULTS_DIR);
    const ids = new Set(ROWS.map((row) => row.id));
    for (const id of results.keys()) expect(ids.has(id)).toBe(true);
  });

  test('REQ-CONF-8: the committed REPORT.md is what renderReport produces from the committed results', () => {
    const results = readResults(RESULTS_DIR);
    const rendered = renderReport(ROWS, results);
    const committed = readFileSync(REPORT_PATH, 'utf8');
    expect(rendered).toBe(committed);
  });

  test('REQ-CONF-8: REPORT.md contains no em or en dash', () => {
    const committed = readFileSync(REPORT_PATH, 'utf8');
    expect(containsAny(committed, EM_OR_EN_DASH)).toBe(false);
  });

  test('REQ-CONF-9: every failing core vector in the committed results has an issue draft file', () => {
    const results = readResults(RESULTS_DIR);
    for (const [rowId, summary] of results) {
      for (const result of summary.results) {
        if (result.tier === 'core' && (result.status === 'fail' || result.status === 'error')) {
          const name = result.id.replace(/^core\//, '');
          const draftPath = join(ISSUES_DIR, `${rowId}-${name}.md`);
          expect(existsSync(draftPath)).toBe(true);
        }
      }
    }
  });

  test('REQ-CONF-9: every issue draft names its vector id, the draft section and a reproduction command', () => {
    const files = readdirSync(ISSUES_DIR).filter((name) => name.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(join(ISSUES_DIR, file), 'utf8');
      expect(content).toMatch(/Vector:/);
      expect(content).toMatch(/Draft section:/);
      expect(content).toMatch(/Reproduction:/);
    }
  });
});
