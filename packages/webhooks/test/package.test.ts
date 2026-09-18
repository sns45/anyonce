import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');

describe('package hygiene', () => {
  test('REQ-WH-1: @anyonce/core is a peer and there are no dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toEqual({ '@anyonce/core': 'workspace:*' });
    expect(pkg.sideEffects).toBe(false);
  });

  test('REQ-WH-1: the source imports only from @anyonce/core and @anyonce/core/http and never from node:', () => {
    for (const file of readdirSync(join(pkgDir, 'src'))) {
      const source = readFileSync(join(pkgDir, 'src', file), 'utf8');
      const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1])
        .filter((specifier): specifier is string => specifier !== undefined);
      for (const specifier of specifiers) {
        if (specifier.startsWith('./')) continue;
        expect(['@anyonce/core', '@anyonce/core/http']).toContain(specifier);
      }
      expect(source).not.toMatch(/node:/);
    }
  });
});
