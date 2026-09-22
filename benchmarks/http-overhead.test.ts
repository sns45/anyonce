import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measure, renderBenchBlock, writeReadme } from './http-overhead';

const root = resolve(import.meta.dir, '..');
const START = '<!-- bench:start -->';
const END = '<!-- bench:end -->';

describe('NFR-1: HTTP adapter overhead', () => {
  test('NFR-1: the HTTP adapter adds under 2 ms p50 over a bare handler with the memory store', async () => {
    const result = await measure({ iterations: 2000, warmup: 200 });
    expect(result.overheadP50Ms.firstExecution).toBeLessThan(2);
    expect(result.overheadP50Ms.replay).toBeLessThan(2);
  }, 10_000);

  test('NFR-1: writeReadme replaces only the text between the bench markers and refuses a README without them', () => {
    const readme = `# Title\n\nBefore.\n\n${START}\nold numbers\n${END}\n\nAfter.\n`;
    const out = writeReadme(readme, 'NEW BLOCK');
    expect(out).toContain('NEW BLOCK');
    expect(out).not.toContain('old numbers');
    expect(out.startsWith('# Title')).toBe(true);
    expect(out.trimEnd().endsWith('After.')).toBe(true);
    expect(() => writeReadme('no markers anywhere in this text', 'x')).toThrow();
    expect(() => writeReadme(`${START} but no end marker`, 'x')).toThrow();
    expect(() => writeReadme(`${END} before ${START}`, 'x')).toThrow();
  });

  test('NFR-1: the README carries a bench block whose recorded p50 overheads are under 2 ms', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const start = readme.indexOf(START);
    const end = readme.indexOf(END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = readme.slice(start + START.length, end);
    const rows = block
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) => line.startsWith('|') && !/^\|[\s-]*\|/.test(line) && !line.includes('Path'),
      );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = row
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '');
      const overheadP50 = Number(cells[3]);
      expect(Number.isNaN(overheadP50)).toBe(false);
      expect(overheadP50).toBeLessThan(2);
    }
  });

  test('NFR-1: renderBenchBlock names runtime, machine and iterations with no em or en dash', () => {
    const rendered = renderBenchBlock(
      {
        bare: { p50Ms: 0.01, p99Ms: 0.02 },
        firstExecution: { p50Ms: 0.03, p99Ms: 0.05 },
        replay: { p50Ms: 0.025, p99Ms: 0.04 },
        overheadP50Ms: { firstExecution: 0.02, replay: 0.015 },
        runtime: 'Bun 1.4.2',
        iterations: 20_000,
      },
      'Darwin 24.6.0, Apple M2 Pro',
    );
    expect(rendered).toContain('Bun 1.4.2');
    expect(rendered).toContain('Darwin 24.6.0, Apple M2 Pro');
    expect(rendered).toContain('20000');
    for (const dash of [String.fromCharCode(0x2013), String.fromCharCode(0x2014)]) {
      expect(rendered).not.toContain(dash);
    }
    expect(rendered).not.toContain('bench-first');
    expect(rendered).not.toContain('bench-replay');
  });
});
