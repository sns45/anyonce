import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');
const NODE_SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']node:[a-z_/]+["']/;

describe('package hygiene', () => {
  test('REQ-ST-KV-1: the package declares five store subpaths, no dependencies, and optional peers only', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dependencies?: unknown;
      exports: Record<string, Record<string, string>>;
      peerDependenciesMeta: Record<string, { optional: boolean }>;
    };
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.exports).sort()).toEqual([
      '.',
      './d1',
      './durable-objects',
      './dynamodb',
      './postgres',
      './redis',
    ]);
    expect(Object.keys(pkg.exports)).not.toContain('./kv');
    for (const entry of Object.values(pkg.exports)) {
      expect(Object.keys(entry)).toEqual(['types', 'import', 'require']);
    }
    for (const meta of Object.values(pkg.peerDependenciesMeta)) expect(meta.optional).toBe(true);
  });

  test('REQ-ST-D1-1: no source file imports a node: module, so the D1 and Durable Object entries run in workerd', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(join(pkgDir, 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(readFileSync(file, 'utf8')).not.toMatch(NODE_SPECIFIER_PATTERN);
  });
});
