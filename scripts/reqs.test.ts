import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectTestIds,
  coverageReport,
  expandScope,
  parseDefinedIds,
  parsePhaseDeps,
  parsePhaseScopes,
  phaseScope,
} from './reqs';

const sample = `
### 4.1 Core
- **REQ-CORE-1** Implement things.
- **REQ-CORE-2** Validate keys.
### 4.3 Stores
- **REQ-ST-DO-1** (TS) Durable Objects store.
- **REQ-ST-D1-1** (TS) D1 store.
### 4.7 Conformance
- **REQ-CONF-1** Vector format.
- **REQ-CONF-2** Fixtures.
- **REQ-CONF-3** core tier.
- **REQ-CONF-4** profile tier.
### 4.9 Release
- **REQ-REL-4** CI matrix.
## 5. Non-functional requirements
- **NFR-1** Overhead.
- **NFR-6** Prose.
## 6. Phases
| Phase | Deliverable | REQs | Depends on |
|---|---|---|---|
| P0 Scaffold and vectors | Repo. | CONF-1..4, REL-4 | none |
| P1 Core | Engine. | CORE-1..2 | P0 |
| P3 Stores | Stores. | ST-* | P1 |
| P4a Queue door | Queue. | CORE-2 | P1 |
| P4b Webhook door | Webhook. | REL-4 | P3 |
| P6 Docs | Docs. | NFR-* | P3, P4a, P4b |
| P7 Standards and launch | S1..S3 executed. | 0.4 | P6 |
`;

describe('reqs script', () => {
  test('reqs script: parses every bold REQ and NFR definition once', () => {
    expect(parseDefinedIds(sample)).toEqual([
      'REQ-CORE-1',
      'REQ-CORE-2',
      'REQ-ST-DO-1',
      'REQ-ST-D1-1',
      'REQ-CONF-1',
      'REQ-CONF-2',
      'REQ-CONF-3',
      'REQ-CONF-4',
      'REQ-REL-4',
      'NFR-1',
      'NFR-6',
    ]);
  });

  test('reqs script: expands ranges, wildcards and NFR entries against the defined ids', () => {
    const defined = parseDefinedIds(sample);
    expect(expandScope('CONF-1..4, REL-4', defined)).toEqual([
      'REQ-CONF-1',
      'REQ-CONF-2',
      'REQ-CONF-3',
      'REQ-CONF-4',
      'REQ-REL-4',
    ]);
    expect(expandScope('ST-*', defined)).toEqual(['REQ-ST-DO-1', 'REQ-ST-D1-1']);
    expect(expandScope('NFR-*', defined)).toEqual(['NFR-1', 'NFR-6']);
    expect(expandScope('0.4', defined)).toEqual([]);
  });

  test('reqs script: maps phases from the section 6 table', () => {
    const scopes = parsePhaseScopes(sample, parseDefinedIds(sample));
    expect([...scopes.keys()]).toEqual(['p0', 'p1', 'p3', 'p4a', 'p4b', 'p6', 'p7']);
    expect(scopes.get('p1')).toEqual(['REQ-CORE-1', 'REQ-CORE-2']);
    expect(scopes.get('p4a')).toEqual(['REQ-CORE-2']);
    expect(scopes.get('p4b')).toEqual(['REQ-REL-4']);
    expect(scopes.get('p7')).toEqual([]);
  });

  test('reqs script: phase scope is the phase plus the transitive closure of its dependencies', () => {
    const defined = parseDefinedIds(sample);
    const scopes = parsePhaseScopes(sample, defined);
    const deps = parsePhaseDeps(sample);
    expect(phaseScope('p0', scopes, deps)).toEqual(scopes.get('p0') ?? []);
    const p4a = phaseScope('p4a', scopes, deps);
    expect(p4a).toEqual([...(scopes.get('p0') ?? []), ...(scopes.get('p1') ?? [])]);
    for (const id of scopes.get('p3') ?? []) expect(p4a).not.toContain(id);
    const p6 = phaseScope('p6', scopes, deps);
    for (const phase of ['p0', 'p1', 'p3', 'p4a', 'p4b', 'p6']) {
      for (const id of scopes.get(phase) ?? []) expect(p6).toContain(id);
    }
  });

  test('reqs script: collects ids from TypeScript and Go test names', () => {
    const root = mkdtempSync(join(tmpdir(), 'reqs-'));
    mkdirSync(join(root, 'pkg', 'test'), { recursive: true });
    mkdirSync(join(root, 'go', 'x'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(root, 'pkg', 'src', 'testing'), { recursive: true });
    mkdirSync(join(root, 'go', 'storetest'), { recursive: true });
    mkdirSync(join(root, 'pkg', 'src', 'other'), { recursive: true });
    writeFileSync(
      join(root, 'pkg', 'test', 'a.test.ts'),
      'test(\'REQ-CONF-1: validates\', () => {});\nit("REQ-CONF-2: fixtures", () => {});\ntest(`NFR-6: prose`, () => {});\n',
    );
    writeFileSync(
      join(root, 'go', 'x', 'a_test.go'),
      'func TestREQ_CONF_2_fixture(t *testing.T) {\n\tt.Run("REQ-REL-4: ci", func(t *testing.T) {})\n}\n',
    );
    writeFileSync(
      join(root, 'node_modules', 'dep', 'z.test.ts'),
      "test('REQ-CORE-1: ignored', () => {});\n",
    );
    writeFileSync(
      join(root, 'pkg', 'src', 'testing', 'index.ts'),
      "test('REQ-STORE-9: scoped', () => {});\n",
    );
    writeFileSync(
      join(root, 'go', 'storetest', 'storetest.go'),
      'package storetest\n\nfunc TestREQ_STORE_8_race(t *testing.T) {\n\tt.Run("REQ-STORE-8: race", func(t *testing.T) {})\n}\n',
    );
    writeFileSync(
      join(root, 'pkg', 'src', 'other', 'index.ts'),
      "test('REQ-NOPE-1: not a suite', () => {});\n",
    );
    const found = collectTestIds(root);
    expect([...found.keys()].sort()).toEqual([
      'NFR-6',
      'REQ-CONF-1',
      'REQ-CONF-2',
      'REQ-REL-4',
      'REQ-STORE-8',
      'REQ-STORE-9',
    ]);
    expect(found.get('REQ-CONF-2')).toHaveLength(2);
    expect(found.get('REQ-STORE-8')).toBeDefined();
    expect(found.get('REQ-STORE-9')).toBeDefined();
    expect(found.has('REQ-NOPE-1')).toBe(false);
  });

  test('reqs script: reports uncovered ids in scope and unknown ids in tests', () => {
    const defined = ['REQ-CONF-1', 'REQ-CONF-2'];
    const found = new Map([
      ['REQ-CONF-1', ['a.test.ts']],
      ['REQ-NOPE-9', ['b.test.ts']],
    ]);
    const report = coverageReport(defined, ['REQ-CONF-1', 'REQ-CONF-2'], found);
    expect(report.uncovered).toEqual(['REQ-CONF-2']);
    expect(report.unknown).toEqual(['REQ-NOPE-9']);
    expect(report.ok).toBe(false);
  });
});
