import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const S1 = 'docs/standards/S1-wg-pr.md';
const S2 = 'docs/standards/S2-mailing-list.md';
const S3 = 'docs/standards/S3-draft-issues.md';
const GAPS = 'conformance/DRAFT-GAPS.md';

/** Every fenced block of one language, in order of appearance. */
function fenced(markdown: string, lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\``, 'gm');
  for (let m = re.exec(markdown); m !== null; m = re.exec(markdown)) out.push(m[1] ?? '');
  return out;
}

/** GitHub's heading anchor for one heading text, as test/docs.test.ts computes it. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');
}

/** Every heading anchor of a markdown file, with GitHub's numeric suffix for repeats. */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const m = inFence ? null : line.match(/^#{1,6} (.+)$/);
    if (m === null) continue;
    const base = slug(m[1] ?? '');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${count}`);
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
  let inFence = false;
  const end = rest.findIndex((line) => {
    if (line.startsWith('```')) inFence = !inFence;
    const m = inFence ? null : line.match(/^(#+) /);
    return m !== null && (m[1]?.length ?? 0) <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

interface Gap {
  n: number;
  title: string;
  draftSection: string;
  proposed: string[];
  status: string;
}

/**
 * The proposed draft text of one DRAFT-GAPS entry. The value of the `Proposed draft text:` line
 * holds one or more double quoted passages, optionally followed by unquoted commentary. A passage
 * opens with a double quote at the start of the value or right after ": ", and closes at the first
 * full stop immediately followed by a double quote and then a space or the end of the line. Inner
 * quotes such as `the Token "true".` never close a passage, because their full stop sits outside
 * the quote. The passages are returned without their delimiting quotes.
 */
function passages(value: string): string[] {
  const out: string[] = [];
  const re = /(?:^|: )"(.*?\.)"(?= |$)/g;
  for (let m = re.exec(value); m !== null; m = re.exec(value)) out.push(m[1] ?? '');
  return out;
}

/** Every `### G<n>: <title>` entry of DRAFT-GAPS.md, skipping the fenced format template. */
function gaps(): Gap[] {
  const text = read(GAPS);
  const out: Gap[] = [];
  const re = /^### G(\d+): (.+)$/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const n = Number(m[1]);
    if (!Number.isInteger(n)) continue;
    const body = section(text, new RegExp(`^### G${n}: `)) ?? '';
    const line = (label: string): string =>
      body
        .split('\n')
        .find((l) => l.startsWith(`${label}: `))
        ?.slice(label.length + 2) ?? '';
    out.push({
      n,
      title: m[2] ?? '',
      draftSection: line('Draft section'),
      proposed: passages(line('Proposed draft text')),
      status: line('Status'),
    });
  }
  return out;
}

/** The S3 section for one gap. */
function issue(n: number): string | undefined {
  return section(read(S3), new RegExp(`^## G${n}: `));
}

interface Tally {
  pass: number;
  total: number;
}

/** Core and profile pass counts recomputed from one committed run summary. */
function tally(file: string): { core: Tally; profile: Tally } {
  const run = JSON.parse(read(`conformance/results/${file}`)) as {
    results: { id: string; tier: string; status: string }[];
  };
  const count = (tier: string): Tally => {
    const graded = run.results.filter((r) => r.tier === tier && r.status !== 'not-applicable');
    return { pass: graded.filter((r) => r.status === 'pass').length, total: graded.length };
  };
  return { core: count('core'), profile: count('profile') };
}

/** Name and version of every third party row in the REPORT.md matrix. */
function thirdParties(): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  const matrix = section(read('conformance/REPORT.md'), /^## Matrix$/) ?? '';
  for (const line of matrix.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const name = cells[1] ?? '';
    const version = cells[2] ?? '';
    if (name === '' || name === 'anyonce' || name === 'Implementation') continue;
    if (/^-+$/.test(name) || version === '') continue;
    out.push({ name, version });
  }
  return out;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const UNSENT = /^This is an unsent draft held in the anyonce repository\./m;
/** The opening paragraph that says nothing was sent, which is the one place these verbs may appear. */
const UNSENT_PARAGRAPH = /^This is an unsent draft held in the anyonce repository\..*$/m;
const SENT_CLAIMS: RegExp[] = [
  /\b(I|we) (have |had )?(sent|filed|posted|opened|submitted|emailed|mailed)\b/i,
  /\b(was|were|is|are) (now )?(sent|filed|posted|opened|submitted)\b/i,
  /\b(has|have|had) (now |already )?been (sent|filed|posted|opened|submitted|emailed|mailed)\b/i,
  /\bissue filed https?:/i,
  /\balready (sent|filed|posted|opened|submitted)\b/i,
];

/**
 * docs/reference/draft-07.txt as one line: the page footer and running header dropped and every run
 * of whitespace collapsed to a single space, which is how DRAFT-GAPS.md quotes the draft.
 */
function draftText(): string {
  return read('docs/reference/draft-07.txt')
    .split('\n')
    .filter((l) => !/^(Jena & Dalal {2,}Expires|Internet-Draft {2,}The Idempotency-Key)/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** The shared footer of S3, quoted as a block but written by anyonce rather than taken from the draft. */
const FOOTER = /^> This came out of implementing the draft twice/;

/** Every `> ` quotation line of a markdown file outside fenced blocks, except the S3 footer. */
function quotations(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    if (inFence || !line.startsWith('> ') || FOOTER.test(line)) continue;
    out.push(line.slice(2));
  }
  return out;
}

/**
 * Every pass count a draft quotes is the one conformance/results records: the vector totals, the
 * anyonce line, the number of anyonce runs, and each third party's core count wherever its name and
 * version are followed on the same line by a `core x/y` figure.
 */
function expectCounts(path: string): void {
  const text = read(path);
  const vectors = (tier: string): number =>
    readdirSync(join(root, 'conformance/vectors', tier)).filter((f) => f.endsWith('.json')).length;
  expect(text, path).toContain(`${vectors('core')} core vectors`);
  expect(text, path).toContain(`${vectors('profile')} profile vectors`);

  const files = readdirSync(join(root, 'conformance/results')).filter((f) => f.endsWith('.json'));
  const own = files.filter((f) => f.startsWith('anyonce-'));
  expect(own.length).toBeGreaterThanOrEqual(11);
  for (const file of own) {
    const { core, profile } = tally(file);
    expect(core.pass, file).toBe(core.total);
    expect(profile.pass, file).toBe(profile.total);
  }
  const { core, profile } = tally(own[0] ?? '');
  expect(text, path).toMatch(
    new RegExp(
      `anyonce[^\\n]*core ${core.pass}/${core.total}[^\\n]*profile ${profile.pass}/${profile.total}`,
    ),
  );
  expect(text, path).toContain(`${own.length} runs`);

  const parties = thirdParties();
  expect(parties.map((p) => p.name).sort()).toEqual(['fiber', 'hono-idempotency', 'idempo']);
  for (const { name, version } of parties) {
    const file = `${name}.json`;
    expect(files).toContain(file);
    const t = tally(file).core;
    const re = new RegExp(`${escapeRegExp(`${name} ${version}`)}[^\\n]*?core (\\d+)/(\\d+)`, 'g');
    const quoted = [...text.matchAll(re)].map((m) => `${m[1]}/${m[2]}`);
    expect(quoted.length, `${path} ${name}`).toBeGreaterThan(0);
    for (const q of quoted) expect(q, `${path} ${name}`).toBe(`${t.pass}/${t.total}`);
  }
}

describe('standards drafts', () => {
  test('S1: the WG PR draft exists, says it is unsent, targets draft-ietf-httpapi-idempotency-key-header-07 section 4 and RFC 7942, and links the suite and the report', () => {
    expect(existsSync(join(root, S1))).toBe(true);
    const s1 = read(S1);
    expect(s1).toMatch(UNSENT);
    for (const needle of [
      'draft-ietf-httpapi-idempotency-key-header-07',
      'Section 4',
      'Implementation Status',
      'RFC 7942',
      'github.com/ietf-wg-httpapi/idempotency',
      'draft-ietf-httpapi-idempotency-key-header.md',
      'dab060c',
      'https://github.com/sns45/anyonce/tree/main/conformance',
      'https://github.com/sns45/anyonce/blob/main/conformance/REPORT.md',
      'If the editors prefer an issue',
    ]) {
      expect(s1).toContain(needle);
    }
    const entry = fenced(s1, 'markdown').find((block) => block.startsWith('Organization: '));
    expect(entry, 'no kramdown entry opening with Organization:').toBeDefined();
    expect(entry).toStartWith('Organization: anyonce (Shantanu Sharma, individual)\n');
    for (const field of [
      '- Implementation:',
      '- Description:',
      '- Level of maturity:',
      '- Version compatibility: draft-ietf-httpapi-idempotency-key-header-07',
      '- Coverage:',
      '- Licensing:',
      '- Implementation experience:',
      '- Contact:',
      '- Information accurate as of:',
      '- Reference:',
    ]) {
      expect(entry).toContain(field);
    }
    expect(entry).toContain('pre-release');
    expect(s1).toContain('shared asset rather than a scorecard');
  });

  test('S1: the WG PR draft quotes the pass counts that conformance/results records for every implementation', () => {
    expectCounts(S1);
  });

  test('S2: the mailing list draft quotes the pass counts that conformance/results records for every implementation', () => {
    const s2 = read(S2);
    expect(s2).toMatch(UNSENT);
    expect(s2).toMatch(/^To: httpapi@ietf\.org$/m);
    expect(s2).toMatch(/^Subject: .+$/m);
    expectCounts(S2);
    const body = fenced(s2, 'text')[0] ?? '';
    const long = body
      .split('\n')
      .filter((l) => l.length > 72 && !/https?:\/\//.test(l) && !l.startsWith('Subject: '));
    expect(long, 'mail body lines over 72 columns').toEqual([]);
    // The 4xx summary names what the run measured.
    expect(body).toContain('hono-idempotency does not');
  });

  test('S3: the G14 issue and DRAFT-GAPS entry describe the two behaviours the run measured', () => {
    for (const path of [S3, GAPS]) {
      expect(read(path), path).not.toContain('three different ways');
      expect(read(path), path).toContain('two different ways, and neither matches anyonce');
    }
  });

  test('S3: every quotation in the drafts is verbatim draft-ietf-httpapi-idempotency-key-header-07 text', () => {
    const draft = draftText();
    let count = 0;
    for (const path of [S1, S2, S3]) {
      for (const q of quotations(read(path))) {
        count++;
        expect(draft.includes(q), `${path}: ${q}`).toBe(true);
      }
    }
    expect(count).toBeGreaterThanOrEqual(20);
    expect(draft).toContain('success or an error.');
    expect(read(S2)).toContain('"success or an error"');
  });

  test('S3: every DRAFT-GAPS entry has an issue draft citing the same draft sections', () => {
    const all = gaps();
    expect(all.map((g) => g.n)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    const s3 = read(S3);
    expect(s3).toMatch(UNSENT);
    for (const gap of all) {
      expect(gap.draftSection).not.toBe('');
      expect(s3, `G${gap.n} heading`).toContain(`\n## G${gap.n}: ${gap.title}\n`);
      const body = issue(gap.n);
      expect(body).toBeDefined();
      expect(body).toContain(`\nDraft section: ${gap.draftSection}\n`);
      expect(body).toMatch(/^Issue title: .+$/m);
      expect(anchors(s3).has(slug(`G${gap.n}: ${gap.title}`))).toBe(true);
    }
  });

  test("S3: every issue draft's proposed text equals the DRAFT-GAPS proposed text byte for byte", () => {
    for (const gap of gaps()) {
      expect(gap.proposed.length, `G${gap.n} has no proposed passage`).toBeGreaterThan(0);
      const body = issue(gap.n) ?? '';
      const proposed = section(body, /^### Proposed text$/) ?? '';
      const blocks = fenced(proposed, 'text').map((b) => b.replace(/\n$/, ''));
      expect(blocks, `G${gap.n}`).toEqual(gap.proposed);
    }
    expect(gaps().find((g) => g.n === 12)?.proposed.length).toBe(2);
  });

  test('S3: wave 1 is G4, G5, G6 with G7, G8 and G16 (Q85)', () => {
    const wave = (n: number): string => (issue(n) ?? '').match(/^Wave: (\d)$/m)?.[1] ?? '';
    const one = gaps()
      .filter((g) => wave(g.n) === '1')
      .map((g) => g.n);
    const two = gaps()
      .filter((g) => wave(g.n) === '2')
      .map((g) => g.n);
    expect(one).toEqual([4, 5, 6, 7, 8, 16]);
    expect(two).toEqual([1, 2, 3, 9, 10, 11, 12, 13, 14, 15, 17]);
    expect(issue(6)).toMatch(/^Grouping: one issue with G7$/m);
    expect(issue(7)).toMatch(/^Grouping: one issue with G6$/m);
    expect(issue(6)?.match(/^Issue title: (.+)$/m)?.[1]).toBe(
      issue(7)?.match(/^Issue title: (.+)$/m)?.[1],
    );
  });

  test('S1, S2, S3: no em or en dash and no claim that anything was sent', () => {
    const dashes = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)];
    for (const path of [S1, S2, S3]) {
      const text = read(path);
      for (const dash of dashes) expect(text.includes(dash), path).toBe(false);
      expect(text, path).toMatch(UNSENT);
      const rest = text.replace(UNSENT_PARAGRAPH, '');
      for (const claim of SENT_CLAIMS) expect(rest, `${path} ${claim}`).not.toMatch(claim);
    }
  });

  test('P7: the launch drafts are marked unsent and quote the committed counts (Q86)', () => {
    const dir = join(root, 'docs/launch');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const texts = files.map((f) => ({ path: `docs/launch/${f}`, text: read(`docs/launch/${f}`) }));
    for (const { path, text } of texts) expect(text, path).toMatch(/^> Unsent drafts?\. /);

    const all = texts.map((t) => t.text).join('\n');
    for (const { name, version } of thirdParties()) {
      const t = tally(`${name}.json`).core;
      const re = new RegExp(
        `${escapeRegExp(`${name} ${version}`)}(?: passes|:) (\\d+)(?: of (\\d+))?`,
        'gi',
      );
      const quoted = [...all.matchAll(re)];
      expect(quoted.length, name).toBeGreaterThan(0);
      for (const m of quoted) {
        expect(Number(m[1]), name).toBe(t.pass);
        if (m[2] !== undefined) expect(Number(m[2]), name).toBe(t.total);
      }
    }
    const gapCounts = [...all.matchAll(/(\d+) places where the draft/g)].map((m) => Number(m[1]));
    expect(gapCounts.length).toBeGreaterThan(0);
    for (const n of gapCounts) expect(n).toBe(gaps().length);
  });

  test('S3: every DRAFT-GAPS status line points at its issue draft', () => {
    const s3 = anchors(read(S3));
    for (const gap of gaps()) {
      const anchor = slug(`G${gap.n}: ${gap.title}`);
      expect(s3.has(anchor)).toBe(true);
      expect(gap.status).toBe(
        `open, issue drafted in [docs/standards/S3-draft-issues.md](../docs/standards/S3-draft-issues.md#${anchor})`,
      );
    }
    expect(read(GAPS)).toContain('Status: open | issue filed <url>');
  });
});
