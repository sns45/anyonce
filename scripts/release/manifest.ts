/**
 * Checks a packed package.json (the one inside a tarball, after `bun pm pack` rewrote the workspace
 * protocol) against NFR-3 and Q60: an `exports` map whose every conditional entry names `types`, an ESM
 * `import` and a CJS `require`; `sideEffects: false`; and no `workspace:` specifier left in any
 * dependency field, since npm cannot install one.
 */

const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
] as const;
const CONDITIONS = ['types', 'import', 'require'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns every problem found in the packed manifest; an empty list means it is fit to publish. */
export function checkPackedManifest(manifest: unknown, name: string): string[] {
  if (!isRecord(manifest)) return [`${name}: package.json is not a JSON object`];
  const problems: string[] = [];

  if (manifest.name !== name) problems.push(`${name}: name is ${JSON.stringify(manifest.name)}`);
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    problems.push(`${name}: version is missing`);
  }
  if (manifest.sideEffects !== false) {
    problems.push(
      `${name}: sideEffects is ${JSON.stringify(manifest.sideEffects)}, expected false`,
    );
  }

  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (!isRecord(deps)) {
      problems.push(`${name}: ${field} is not an object`);
      continue;
    }
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        problems.push(
          `${name}: ${field}.${dep} is ${range}, a workspace: specifier npm cannot install`,
        );
      }
    }
  }

  const exportsMap = manifest.exports;
  if (!isRecord(exportsMap) || Object.keys(exportsMap).length === 0) {
    problems.push(`${name}: exports map is missing`);
  } else {
    if (!isRecord(exportsMap['.']))
      problems.push(`${name}: exports has no "." entry with conditions`);
    for (const [subpath, target] of Object.entries(exportsMap)) {
      // A plain string target (for example "./migrations/*") ships data files, not code.
      if (typeof target === 'string') continue;
      if (!isRecord(target)) {
        problems.push(`${name}: exports["${subpath}"] is neither a path nor a conditions object`);
        continue;
      }
      for (const condition of CONDITIONS) {
        if (typeof target[condition] !== 'string') {
          problems.push(`${name}: exports["${subpath}"] has no ${condition} entry`);
        }
      }
      const esm = target.import;
      const cjs = target.require;
      if (typeof esm === 'string' && !esm.endsWith('.js')) {
        problems.push(`${name}: exports["${subpath}"].import is ${esm}, expected an ESM .js file`);
      }
      if (typeof cjs === 'string' && !cjs.endsWith('.cjs')) {
        problems.push(`${name}: exports["${subpath}"].require is ${cjs}, expected a .cjs file`);
      }
    }
  }

  // The top level entries are optional (stores ships subpaths only), but when present they must agree
  // with the "." export so older resolvers get the same files.
  const root = isRecord(exportsMap) && isRecord(exportsMap['.']) ? exportsMap['.'] : undefined;
  const pairs = [
    ['types', 'types'],
    ['module', 'import'],
    ['main', 'require'],
  ] as const;
  for (const [field, condition] of pairs) {
    if (manifest[field] === undefined || root === undefined) continue;
    if (manifest[field] !== root[condition]) {
      problems.push(
        `${name}: ${field} is ${String(manifest[field])} but exports["."].${condition} is ${String(root[condition])}`,
      );
    }
  }

  return problems;
}

/** Reads `package/package.json` out of a packed tarball without unpacking it. */
export function readPackedManifest(tarball: string): unknown {
  const result = Bun.spawnSync(['tar', '-xzOf', tarball, 'package/package.json']);
  if (result.exitCode !== 0) throw new Error(`${tarball}: ${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString()) as unknown;
}

// CLI: `bun scripts/release/manifest.ts <tarball>...` exits 1 when any packed manifest has a problem.
if (import.meta.main) {
  const tarballs = process.argv.slice(2);
  if (tarballs.length === 0) {
    console.error('usage: bun scripts/release/manifest.ts <tarball>...');
    process.exit(2);
  }
  let failed = false;
  for (const tarball of tarballs) {
    const manifest = readPackedManifest(tarball);
    const name = isRecord(manifest) && typeof manifest.name === 'string' ? manifest.name : tarball;
    const problems = checkPackedManifest(manifest, name);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) failed = true;
    else console.log(`${name}: packed manifest ok`);
  }
  if (failed) process.exit(1);
}
