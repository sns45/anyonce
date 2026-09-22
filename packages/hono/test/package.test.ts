import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');

describe('package hygiene', () => {
  test('REQ-HTTP-16: hono and @anyonce/core are peers and there are no dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toEqual({ '@anyonce/core': 'workspace:^', hono: '>=4.8.0' });
    expect(pkg.sideEffects).toBe(false);
  });

  test('REQ-HTTP-16: the source imports only from @anyonce/core, @anyonce/core/http and hono', () => {
    const source = readFileSync(join(pkgDir, 'src/index.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .filter((specifier): specifier is string => specifier !== undefined);
    for (const specifier of specifiers) {
      expect(['@anyonce/core', '@anyonce/core/http', 'hono', 'hono/route']).toContain(specifier);
    }
    expect(source).not.toMatch(/node:/);
  });
});
