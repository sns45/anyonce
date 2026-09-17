import { defineConfig } from 'tsup';

/**
 * Deno resolves "node:fs" natively but not the bare "fs" specifier tsup's esbuild otherwise
 * strips it to by default; keep the source's own "node:" prefix so the loader (node:fs,
 * node:path, node:url) still works unchanged on Deno and Node.
 */
export default defineConfig({
  removeNodeProtocol: false,
});
