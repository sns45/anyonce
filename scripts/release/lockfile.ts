#!/usr/bin/env bun
/**
 * The lockfile forgeseal reads to build one packed package's SBOM (REQ-REL-2).
 *
 * A tarball ships no lockfile, and `forgeseal sbom` builds its component list from one. Pointing it at the
 * workspace bun.lock would list every dev tool in the monorepo as a component of every package. Instead the
 * workspace lockfile is pruned to the packed package's runtime closure: its `dependencies` and
 * `optionalDependencies`, followed transitively through the lockfile. Peer dependencies are left out because
 * the consumer installs them; devDependencies are left out because they never reach a consumer. The result is
 * written as `bun.lock` next to the unpacked `package.json`, so `forgeseal sbom --dir <unpacked>` names the
 * package from its own manifest and lists exactly what installing the tarball pulls in.
 *
 * CLI: `bun scripts/release/lockfile.ts <workspace bun.lock> <unpacked package dir>`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type BunLock = {
  lockfileVersion: number;
  workspaces: Record<string, unknown>;
  packages: Record<string, unknown>;
};

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses bun.lock, which is JSON with trailing commas. Commas are only dropped outside string literals. */
export function parseBunLock(text: string): BunLock {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',' && /^\s*[\]}]/.test(text.slice(i + 1, i + 64))) continue;
    out += ch;
  }
  const parsed: unknown = JSON.parse(out);
  if (!isRecord(parsed) || !isRecord(parsed.packages))
    throw new Error('bun.lock has no packages map');
  return {
    lockfileVersion: typeof parsed.lockfileVersion === 'number' ? parsed.lockfileVersion : 1,
    workspaces: isRecord(parsed.workspaces) ? parsed.workspaces : {},
    packages: parsed.packages,
  };
}

/** The dependency names a lockfile entry (`[ident, registry, meta, integrity]`) declares at runtime. */
function entryDependencies(entry: unknown): string[] {
  if (!Array.isArray(entry)) return [];
  const names: string[] = [];
  for (const part of entry) {
    if (!isRecord(part)) continue;
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      const deps = part[field];
      if (isRecord(deps)) names.push(...Object.keys(deps));
    }
  }
  return names;
}

/**
 * Prunes a workspace lockfile to one package's runtime closure. bun keys a hoisted package by its name and
 * a nested copy by `<parent key>/<name>`, so a dependency of `parent` resolves to the nested key first and
 * the hoisted key otherwise.
 */
export function prunedLockfile(lock: BunLock, manifest: Manifest): BunLock {
  const packages: Record<string, unknown> = {};
  const queue: Array<{ from: string | undefined; name: string }> = [];
  for (const deps of [manifest.dependencies, manifest.optionalDependencies]) {
    for (const name of Object.keys(deps ?? {})) queue.push({ from: undefined, name });
  }
  while (queue.length > 0) {
    const { from, name } = queue.shift() as { from: string | undefined; name: string };
    const nested = from === undefined ? undefined : `${from}/${name}`;
    const key =
      nested !== undefined && nested in lock.packages
        ? nested
        : name in lock.packages
          ? name
          : undefined;
    if (key === undefined)
      throw new Error(`${manifest.name}: ${name} is not in the workspace lockfile`);
    if (key in packages) continue;
    packages[key] = lock.packages[key];
    for (const dep of entryDependencies(lock.packages[key])) queue.push({ from: key, name: dep });
  }
  const workspace: Record<string, unknown> = { name: manifest.name };
  if (manifest.dependencies !== undefined) workspace.dependencies = manifest.dependencies;
  if (manifest.optionalDependencies !== undefined)
    workspace.optionalDependencies = manifest.optionalDependencies;
  return { lockfileVersion: lock.lockfileVersion, workspaces: { '': workspace }, packages };
}

if (import.meta.main) {
  const [lockPath, dir] = process.argv.slice(2);
  if (lockPath === undefined || dir === undefined) {
    console.error(
      'usage: bun scripts/release/lockfile.ts <workspace bun.lock> <unpacked package dir>',
    );
    process.exit(2);
  }
  const lock = parseBunLock(readFileSync(lockPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  const pruned = prunedLockfile(lock, manifest);
  writeFileSync(join(dir, 'bun.lock'), `${JSON.stringify(pruned, null, 2)}\n`);
  console.log(
    `${manifest.name}: SBOM lockfile with ${Object.keys(pruned.packages).length} runtime packages`,
  );
}
