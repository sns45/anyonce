import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The repository's examples directory. */
export const EXAMPLES_DIR = join(import.meta.dir, '../examples');

/**
 * The examples that are nested Go modules: a directory under examples/ whose go.mod declares a module. The CI
 * workflow test and the examples inventory test both use this one rule.
 */
export function goExamples(dir: string = EXAMPLES_DIR): string[] {
  return readdirSync(dir).filter((name) => {
    try {
      return readFileSync(join(dir, name, 'go.mod'), 'utf8').startsWith('module ');
    } catch {
      return false;
    }
  });
}
