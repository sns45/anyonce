import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { PROBLEM_STATUS, type ProblemCode } from '@anyonce/core/http';

const root = resolve(import.meta.dir, '..');
const docs = join(root, 'docs');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** Every fenced block of one language, in order of appearance. */
function fenced(markdown: string, lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\``, 'gm');
  for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) out.push(m[1] ?? '');
  return out;
}

/** Every file under dir, as repository relative paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(relative(root, full));
  }
  return out;
}

/** The body of the section a heading line opens, up to the next heading of the same or a higher level. */
function section(markdown: string, heading: RegExp): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const level = (lines[start] ?? '').match(/^#+/)?.[0].length ?? 1;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const m = line.match(/^(#+) /);
    return m !== null && (m[1]?.length ?? 0) <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('docs', () => {
  test('REQ-DOC-2: semantics has a Mermaid state diagram with every state and the Q3 sentence verbatim', () => {
    const semantics = read('docs/semantics.md');
    const diagrams = fenced(semantics, 'mermaid');
    const state = diagrams.find((d) => d.includes('stateDiagram-v2'));
    expect(state).toBeDefined();
    for (const name of ['absent', 'in_flight', 'completed']) expect(state).toContain(name);
    for (const transition of ['begin', 'complete', 'abandon', 'lease', 'ttl']) {
      expect(state?.toLowerCase()).toContain(transition);
    }
    expect(semantics).toContain('a scope is bound to one consumer group in one language');
  });

  test('REQ-DOC-2: semantics states the honest limits and the Workers waitUntil note', () => {
    const semantics = read('docs/semantics.md');
    expect(semantics).toContain('waitUntil');
    expect(semantics).toContain('does not roll back');
    expect(semantics).toContain('at most one handler execution per key while the record is alive');
    for (const field of ['routeScope', 'keyLookup', 'body']) expect(semantics).toContain(field);
    expect(semantics).toContain('stale_fence');
  });

  test('REQ-DOC-3: stores lists every store, the KV exclusion and links every migration file that exists', () => {
    const stores = read('docs/stores.md');
    for (const name of [
      'memory',
      'durable-objects',
      'd1',
      'dynamodb',
      'redis',
      'postgres',
      'sqlite',
    ]) {
      expect(stores).toMatch(new RegExp(`^\\| ${name} \\|`, 'm'));
    }
    expect(stores).toContain('Cloudflare KV');
    expect(stores).toContain('eventually consistent');
    const migrations = [
      ...walk(join(root, 'packages/stores/migrations')),
      'go/store/postgres/schema.sql',
      'go/store/sqlite/schema.sql',
    ].filter((path) => path.endsWith('.sql'));
    expect(migrations.length).toBeGreaterThanOrEqual(4);
    for (const path of migrations) expect(stores).toContain(`](../${path})`);
  });

  test('REQ-DOC-4: problems documents every problem code in the catalogue with an example body', () => {
    const problems = read('docs/problems.md');
    const codes = Object.keys(PROBLEM_STATUS) as ProblemCode[];
    expect(codes.length).toBeGreaterThanOrEqual(9);
    for (const code of codes) {
      const body = section(problems, new RegExp(`^#{2,4} \`${code}\`$`));
      expect(body, `no heading for ${code}`).toBeDefined();
      expect(body).toContain(`Status: ${PROBLEM_STATUS[code]}`);
      expect(body).toContain('When:');
      const json = fenced(body ?? '', 'json');
      expect(json.length, `no json example for ${code}`).toBeGreaterThan(0);
      const example = JSON.parse(json[0] ?? '{}') as { code?: string; status?: number };
      expect(example.code).toBe(code);
      expect(example.status).toBe(PROBLEM_STATUS[code]);
      expect(json[0]).toContain(`"code": "${code}"`);
    }
  });

  test('REQ-DOC-5: conformance names the CLI, the Go runner, the short-ttl capability and how to add a vector', () => {
    const conformance = read('docs/conformance.md');
    for (const needle of [
      'bunx @anyonce/conformance --url',
      'go/cmd/conformance',
      'runConformance',
      'conformance.Run',
      'short-ttl',
      'conformance/README.md',
      'REPORT.md',
      'draftRef',
      'bun run vectors:validate',
      '--update',
      'N/A',
    ]) {
      expect(conformance).toContain(needle);
    }
  });

  test('REQ-DOC-6: security covers key entropy, principal scope, redaction to 8 characters, the header allowlist and stored bodies', () => {
    const security = read('docs/security.md');
    for (const needle of [
      'newKey()',
      'UUIDv4',
      '122',
      'principal',
      'requirePrincipal',
      'sourceId',
      'redactKey',
      '8 characters',
      'Set-Cookie',
      'WWW-Authenticate: Signature',
      'maxResultBytes',
      '300 KiB',
      'encryption',
    ]) {
      expect(security).toContain(needle);
    }
  });

  test('REQ-DOC-1: every relative link in docs/*.md resolves to a file in the repository', () => {
    const files = readdirSync(docs).filter((name) => name.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const broken: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(docs, name), 'utf8');
      const re = /\]\(([^)\s]+)\)/g;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const target = m[1] ?? '';
        if (/^(https?:|mailto:)/.test(target) || target.startsWith('#')) continue;
        const path = target.split('#')[0] ?? '';
        if (!existsSync(resolve(dirname(join(docs, name)), path)))
          broken.push(`${name}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test('NFR-6: no tracked text file contains an em or en dash', () => {
    const dashes = String.fromCharCode(0x2013, 0x2014);
    const listed = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root });
    expect(listed.exitCode).toBe(0);
    const tracked = listed.stdout
      .toString()
      .split('\0')
      .filter((path) => path !== '')
      .filter((path) => !path.startsWith('docs/reference/'))
      .filter((path) => !/(^|\/)(bun\.lock|package-lock\.json|go\.sum)$/.test(path))
      .filter((path) => !/\.(png|jpe?g|gif|ico|wasm|woff2?|sqlite|db)$/i.test(path));
    const offenders: string[] = [];
    for (const path of tracked) {
      const full = join(root, path);
      if (!existsSync(full)) continue;
      const text = readFileSync(full, 'utf8');
      for (const dash of dashes) {
        if (text.includes(dash)) {
          offenders.push(path);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
