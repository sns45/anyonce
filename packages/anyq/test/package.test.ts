import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as Record<
  string,
  Record<string, string> | undefined
>;

describe('package shape', () => {
  test('REQ-Q-1: the package ships zero runtime dependencies and takes anyq and core as peers', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies ?? {}).sort()).toEqual(['@anyonce/core', '@anyq/core']);
  });

  test('REQ-Q-1: no source file imports the HTTP subpath or a node builtin', () => {
    const glob = new Bun.Glob('*.ts');
    const files = [...glob.scanSync({ cwd: join(import.meta.dir, '../src'), absolute: true })];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('@anyonce/core/http');
      expect(source).not.toMatch(/from '(node:|fs|path)/);
    }
  });
});
