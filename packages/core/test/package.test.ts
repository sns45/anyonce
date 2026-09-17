import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');

export const NODE_SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']node:[a-z_/]+["']/;

describe('package hygiene', () => {
  test('REQ-CORE-7: package.json declares no dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.sideEffects).toBe(false);
  });

  test('REQ-CORE-7: the node: scan matches import specifiers only', () => {
    expect(NODE_SPECIFIER_PATTERN.test("import { x } from 'node:fs'")).toBe(true);
    expect(NODE_SPECIFIER_PATTERN.test('await import("node:fs")')).toBe(true);
    expect(NODE_SPECIFIER_PATTERN.test("require('node:path')")).toBe(true);
    expect(NODE_SPECIFIER_PATTERN.test("const label = 'node:fs'")).toBe(false);
  });

  test('REQ-CORE-7: the bundled root entry imports nothing from node:', async () => {
    const result = await Bun.build({
      entrypoints: [join(pkgDir, 'src/index.ts')],
      target: 'browser',
      minify: false,
    });
    expect(result.success).toBe(true);
    const text = await (result.outputs[0] as { text(): Promise<string> }).text();
    expect(text).not.toMatch(NODE_SPECIFIER_PATTERN);
  });

  test('REQ-CORE-7: no source file under src imports a node: module', () => {
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
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toMatch(NODE_SPECIFIER_PATTERN);
    }
  });

  test('REQ-CORE-7: the root entry never imports the testing suite', async () => {
    const source = readFileSync(join(pkgDir, 'src/index.ts'), 'utf8');
    expect(source).not.toMatch(/from\s*["']\.\/testing/);
    expect(source).not.toMatch(/export\s+\*\s+from\s*["']\.\/testing/);
    const result = await Bun.build({
      entrypoints: [join(pkgDir, 'src/index.ts')],
      target: 'browser',
      minify: false,
    });
    expect(result.success).toBe(true);
    const text = await (result.outputs[0] as { text(): Promise<string> }).text();
    expect(text).not.toContain('storeContractSuite');
  });

  test('REQ-CORE-7: the root entry never imports the http subpath', async () => {
    const source = readFileSync(join(pkgDir, 'src/index.ts'), 'utf8');
    expect(source).not.toMatch(/from\s*["']\.\/http/);
    const result = await Bun.build({
      entrypoints: [join(pkgDir, 'src/index.ts')],
      target: 'browser',
      minify: false,
    });
    expect(result.success).toBe(true);
    const text = await (result.outputs[0] as { text(): Promise<string> }).text();
    expect(text).not.toContain('withIdempotency');
    expect(text).not.toContain('application/problem+json');
  });

  test('REQ-CORE-7: package.json exports the http subpath with types first', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(Object.keys(pkg.exports['./http'] as object)).toEqual(['types', 'import', 'require']);
  });
});
