#!/usr/bin/env bun
/** REQ-REL-5: minified plus gzip size of package entries against their budgets. */
import { join } from 'node:path';

export const CORE_BUDGET_BYTES = 8192;
export const HTTP_BUDGET_BYTES = 16384;

export interface Budget {
  name: string;
  entry: string;
  limit: number;
}

export const BUDGETS: Budget[] = [
  { name: '@anyonce/core', entry: 'packages/core/src/index.ts', limit: CORE_BUDGET_BYTES },
  {
    name: '@anyonce/core/http',
    entry: 'packages/core/src/http/index.ts',
    limit: HTTP_BUDGET_BYTES,
  },
];

export async function measureBundle(entry: string): Promise<{ minified: number; gzip: number }> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    minify: true,
  });
  if (!result.success)
    throw new Error(`bundle failed for ${entry}: ${result.logs.map((l) => l.message).join('; ')}`);
  const output = result.outputs[0];
  if (output === undefined) throw new Error(`no output for ${entry}`);
  const text = await output.text();
  const minified = new TextEncoder().encode(text).byteLength;
  const gzip = Bun.gzipSync(new TextEncoder().encode(text)).byteLength;
  return { minified, gzip };
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  let failed = false;
  for (const budget of BUDGETS) {
    const { minified, gzip } = await measureBundle(join(root, budget.entry));
    const status = gzip <= budget.limit ? 'ok' : 'OVER';
    console.log(
      `${budget.name.padEnd(22)} ${String(gzip).padStart(6)} B gzip (${minified} B min), limit ${budget.limit} B: ${status}`,
    );
    if (gzip > budget.limit) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
