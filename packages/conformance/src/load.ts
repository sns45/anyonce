import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Vector } from './types';

/** Computed lazily, not at module load, so the CJS bundle (with an empty import.meta unless shimmed) doesn't throw on import. */
function defaultVectorsDir(): string {
  return fileURLToPath(new URL('../../../conformance/vectors', import.meta.url));
}

/** Loads every vector file under dir/core and dir/profile, sorted by id. Validation is the schema test's job. */
export function loadVectors(dir: string = defaultVectorsDir()): Vector[] {
  const vectors: Vector[] = [];
  for (const tier of ['core', 'profile']) {
    const tierDir = join(dir, tier);
    const names = readdirSync(tierDir);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      vectors.push(JSON.parse(readFileSync(join(tierDir, name), 'utf8')) as Vector);
    }
  }
  return vectors.sort((a, b) => a.id.localeCompare(b.id));
}
