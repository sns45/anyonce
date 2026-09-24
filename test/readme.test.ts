import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROWS } from '../scripts/report/rows';

const root = resolve(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const readme = (): string => read('README.md');
const llms = (): string => read('llms.txt');

/** Every fenced block of one language, in order of appearance. */
function fenced(markdown: string, lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\``, 'gm');
  for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) out.push(m[1] ?? '');
  return out;
}

/** `import { A, B } from 'specifier';` lines of a code block, mapped to their named imports. */
function importedFrom(block: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /^import\s+\{([^}]+)\}\s+from\s+'([^']+)';$/gm;
  for (let m = re.exec(block); m !== null; m = re.exec(block)) {
    const names = (m[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '' && !name.startsWith('type '));
    const specifier = m[2] ?? '';
    out.set(specifier, [...(out.get(specifier) ?? []), ...names]);
  }
  return out;
}

/** Every non-private package directory under packages/, by directory name. */
function publishedPackageDirs(): string[] {
  return readdirSync(join(root, 'packages')).filter((dir) => {
    const file = join(root, 'packages', dir, 'package.json');
    if (!existsSync(file)) return false;
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { private?: boolean };
    return pkg.private !== true;
  });
}

/** GitHub's heading anchors: lowercase, punctuation other than hyphens and spaces dropped, spaces to hyphens. */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const m = inFence ? null : line.match(/^#{1,6} (.+)$/);
    if (m === null) continue;
    const base = (m[1] ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${count}`);
  }
  return out;
}

/** The lines of one `## heading` section of llms.txt. */
function llmsSection(heading: string): string[] {
  const lines = llms().split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/** `- \`specifier\`: description. exports: a, b, c` lines of an llms.txt section. */
function exportLines(heading: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of llmsSection(heading)) {
    const m = line.match(/^- `([^`]+)`.*\bexports: (.+)$/);
    if (m === null) continue;
    out.set(
      m[1] ?? '',
      (m[2] ?? '')
        .replace(/\.$/, '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    );
  }
  return out;
}

/** Every npm entry point of every published package: package name plus each JS subpath of its exports map. */
function npmEntryPoints(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(join(root, 'packages'))) {
    const file = join(root, 'packages', dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
      name: string;
      private?: boolean;
      exports?: Record<string, unknown>;
    };
    if (pkg.private === true || pkg.exports === undefined) continue;
    for (const subpath of Object.keys(pkg.exports)) {
      // A wildcard subpath ships raw files (the SQL migrations), not a module with exports.
      if (subpath.includes('*')) continue;
      out.push(subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`);
    }
  }
  return out.sort();
}

/** Top-level identifiers declared in a Go package's non-test files, including names inside const/var/type blocks. */
function goDeclared(dir: string): Set<string> {
  const out = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.go') || name.endsWith('_test.go')) continue;
    let block = false;
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (block) {
        if (line === ')') block = false;
        const inner = line.match(/^\t([A-Za-z_][A-Za-z0-9_]*)\b/);
        if (inner !== null) out.add(inner[1] ?? '');
        continue;
      }
      if (/^(const|var|type) \($/.test(line)) {
        block = true;
        continue;
      }
      const top = line.match(/^(?:func|type|var|const) ([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (top !== null) out.add(top[1] ?? '');
    }
  }
  return out;
}

describe('README', () => {
  test('REQ-DOC-1: README names the three doors, links the store matrix, the conformance report and the case study', () => {
    const text = readme();
    for (const door of ['Idempotency-Key', 'anyq', 'webhook-id']) expect(text).toContain(door);
    expect(text).toContain('](docs/stores.md)');
    expect(text).toContain('](conformance/REPORT.md)');
    expect(text).toContain('](docs/conformance.md)');
    expect(text).toContain('](https://in8.sh/work/anyonce)');
    expect(text).toContain('published at launch');
    expect(text).toContain('<!-- bench:start -->');
    expect(text).toContain('<!-- bench:end -->');
    expect(text).toContain('Apache-2.0');
    for (const example of readdirSync(join(root, 'examples'), { withFileTypes: true })) {
      if (example.isDirectory()) expect(text).toContain(`](examples/${example.name})`);
    }
    for (const doc of readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md'))) {
      expect(text).toContain(`](docs/${doc})`);
    }
  });

  test('REQ-DOC-1: README states the producer-supplied idempotency-key recommendation', () => {
    const sentences = readme()
      .replace(/\s+/g, ' ')
      .split(/(?<=\.) /);
    const sentence = sentences.find((s) => s.includes('recommended default'));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('idempotency-key');
    expect(sentence).toContain('redelivery');
    expect(sentence).toContain('producer');
  });

  test('REQ-DOC-1: the README Hono example type checks and replays a duplicate POST', async () => {
    const snippet = fenced(readme(), 'ts')[0];
    expect(snippet).toBeDefined();
    expect(snippet).toContain('new Hono()');
    expect(snippet).toContain('export default app');
    const dir = join(root, 'test', '.tmp');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'readme-hono.ts');
    writeFileSync(file, snippet ?? '');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { noEmit: true },
        include: ['readme-hono.ts'],
      }),
    );
    const tsc = Bun.spawnSync([join(root, 'node_modules', '.bin', 'tsc'), '-p', dir], {
      cwd: root,
    });
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe('');
    expect(tsc.exitCode).toBe(0);

    const mod = (await import(file)) as {
      default: { fetch: (req: Request) => Response | Promise<Response> };
    };
    const post = (): Request =>
      new Request('http://localhost/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'readme-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: 'book' }),
      });
    const first = await mod.default.fetch(post());
    const firstBody = await first.text();
    const second = await mod.default.fetch(post());
    expect(first.status).toBe(201);
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await second.text()).toBe(firstBody);
  }, 60_000);

  test('REQ-DOC-1: the conformance badge text matches the committed anyonce results', () => {
    const rows = ROWS.filter((row) => row.implementation === 'anyonce');
    expect(rows.length).toBeGreaterThan(0);
    const counts = new Set<string>();
    for (const row of rows) {
      const result = JSON.parse(read(`conformance/results/${row.id}.json`)) as {
        results: { tier: string; status: string }[];
      };
      const tally = (tier: string): string => {
        const inTier = result.results.filter((r) => r.tier === tier);
        return `${inTier.filter((r) => r.status === 'pass').length}/${inTier.length}`;
      };
      counts.add(`core ${tally('core')} | profile ${tally('profile')}`);
    }
    // Every anyonce row must agree, or one badge cannot state them.
    expect([...counts]).toHaveLength(1);
    const badge = readme().match(
      /\[!\[conformance\]\((https:\/\/img\.shields\.io\/badge\/[^)]+)\)\]\(conformance\/REPORT\.md\)/,
    );
    expect(badge).not.toBeNull();
    const path = new URL(badge?.[1] ?? '').pathname.replace(/^\/badge\//, '');
    // Shields separates label, message and colour with single dashes; `--` is an escaped literal dash.
    const [label, message] = path
      .split(/(?<!-)-(?!-)/)
      .map((segment) => segment.replace(/--/g, '-'));
    expect(decodeURIComponent(label ?? '')).toBe('conformance');
    expect(decodeURIComponent(message ?? '')).toBe([...counts][0] ?? '');
  });

  test('REQ-DOC-1: every relative link in README.md resolves', () => {
    const text = readme();
    const broken: string[] = [];
    const re = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let links = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const target = m[1] ?? '';
      if (/^(https?:|mailto:)/.test(target)) continue;
      links += 1;
      const [path = '', anchor] = target.split('#');
      const file = path === '' ? join(root, 'README.md') : resolve(root, path);
      if (!existsSync(file)) {
        broken.push(target);
        continue;
      }
      if (anchor !== undefined && file.endsWith('.md')) {
        if (!anchors(readFileSync(file, 'utf8')).has(anchor)) broken.push(target);
      }
    }
    expect(links).toBeGreaterThan(10);
    expect(broken).toEqual([]);
  });

  test('REQ-Q-8: README shows idempotent and idempotencyStrategy in one code block and anyqmw.Wrap with anyqmw.Strategy in one code block', () => {
    const text = readme();
    const ts = fenced(text, 'ts').find(
      (block) => block.includes('idempotent(') && block.includes('idempotencyStrategy()'),
    );
    expect(ts).toBeDefined();
    const go = fenced(text, 'go').find(
      (block) => block.includes('anyqmw.Wrap(') && block.includes('anyqmw.Strategy('),
    );
    expect(go).toBeDefined();
    // Both appear in the queue door's first paragraph block, before any other queue prose moves on.
    const queue = text.indexOf('### Queue consumers');
    expect(queue).toBeGreaterThan(-1);
    expect(text.indexOf(ts ?? '', queue)).toBeGreaterThan(queue);
    expect(text.indexOf(go ?? '', queue)).toBeGreaterThan(queue);
  });
});

describe('llms.txt', () => {
  test('REQ-DOC-8: every export llms.txt lists for an npm entry point is exported by the built package', async () => {
    // The Durable Objects entry imports the Workers runtime module; outside workerd it is stubbed so the
    // built module can be loaded and its export names read.
    mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
    const listed = exportLines('Packages');
    expect(listed.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [specifier, names] of listed) {
      expect(names.length).toBeGreaterThan(0);
      const mod = (await import(specifier)) as Record<string, unknown>;
      for (const name of names) if (!(name in mod)) missing.push(`${specifier}: ${name}`);
    }
    expect(missing).toEqual([]);
  });

  test('REQ-DOC-8: every identifier llms.txt lists for a Go package is declared in that package', () => {
    const listed = exportLines('Go');
    expect(listed.size).toBeGreaterThan(0);
    const prefix = 'github.com/sns45/anyonce/go/';
    const missing: string[] = [];
    for (const [pkg, names] of listed) {
      expect(pkg.startsWith(prefix)).toBe(true);
      const dir = join(root, 'go', pkg.slice(prefix.length));
      expect(existsSync(dir)).toBe(true);
      const declared = goDeclared(dir);
      for (const name of names) {
        if (!/^[A-Z]/.test(name) || !declared.has(name)) missing.push(`${pkg}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
    for (const pkg of [
      'anyonce',
      'httpmw',
      'anyqmw',
      'webhookmw',
      'store/memory',
      'store/sqlite',
    ]) {
      expect(listed.has(`${prefix}${pkg}`)).toBe(true);
    }
  });

  test('REQ-DOC-8: llms.txt lists every npm entry point in every package.json exports map', () => {
    const listed = [...exportLines('Packages').keys()].sort();
    expect(listed).toEqual(npmEntryPoints());
    const text = llms();
    expect(text.startsWith('# anyonce\n')).toBe(true);
    expect(text).toMatch(/^> .+/m);
    for (const doc of readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md'))) {
      expect(llmsSection('Docs').join('\n')).toContain(`docs/${doc}`);
    }
  });
});

describe('package READMEs', () => {
  test('REQ-DOC-8: every published package ships a non-empty README.md with an Install section and the licence', () => {
    for (const dir of publishedPackageDirs()) {
      const text = read(`packages/${dir}/README.md`);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('## Install');
      expect(text).toContain('Apache-2.0');
    }
  });

  test('REQ-DOC-8: every link in a package README is absolute, and a repository blob link resolves to a real file', () => {
    const broken: string[] = [];
    for (const dir of publishedPackageDirs()) {
      const text = read(`packages/${dir}/README.md`);
      const re = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const target = m[1] ?? '';
        if (!/^https?:/.test(target)) {
          broken.push(`packages/${dir}/README.md: relative link ${target}`);
          continue;
        }
        const blob = target.match(/^https:\/\/github\.com\/sns45\/anyonce\/blob\/main\/([^#]+)/);
        if (blob !== null && !existsSync(join(root, blob[1] ?? ''))) {
          broken.push(`packages/${dir}/README.md: ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test('REQ-DOC-8: every @anyonce import named in a package README code block is exported by the built package', async () => {
    // The Durable Objects entry imports the Workers runtime module; outside workerd it is stubbed so the
    // built module can be loaded and its export names read.
    mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
    const missing: string[] = [];
    let checked = 0;
    for (const dir of publishedPackageDirs()) {
      const text = read(`packages/${dir}/README.md`);
      for (const block of fenced(text, 'ts')) {
        for (const [specifier, names] of importedFrom(block)) {
          if (!specifier.startsWith('@anyonce/')) continue;
          checked += 1;
          const mod = (await import(specifier)) as Record<string, unknown>;
          for (const name of names) {
            if (!(name in mod)) missing.push(`packages/${dir}/README.md: ${specifier}: ${name}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
