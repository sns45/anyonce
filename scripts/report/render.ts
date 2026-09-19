/**
 * REQ-CONF-8: a pure renderer from the row manifest plus the collected results to conformance/REPORT.md's
 * markdown. No timestamps, no host names, no ports, no durations: rows render in ROWS order and vectors render
 * in catalog order, so a rerun on an unchanged tree is byte identical. No em or en dash anywhere in the output.
 */
import type { RunSummary, Tier, VectorResult, VectorStatus } from '@anyonce/conformance';
import { CORE_IDS, PROFILE_IDS } from '../../packages/conformance/test/catalog';
import { isThirdParty, type ReportRow, runnerFor } from './rows';

const REGENERATE_COMMAND = 'bun run report -- --update';

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function resultFor(summary: RunSummary, vectorId: string): VectorResult | undefined {
  return summary.results.find((r) => r.id === vectorId);
}

function countByTierStatus(summary: RunSummary, tier: Tier, status: VectorStatus): number {
  return summary.results.filter((r) => r.tier === tier && r.status === status).length;
}

function totalNotApplicable(summary: RunSummary): number {
  return summary.results.filter((r) => r.status === 'not-applicable').length;
}

function vectorName(vectorId: string): string {
  return vectorId.replace(/^core\//, '');
}

function issueLink(row: ReportRow, vectorId: string): string {
  return `[${vectorId}](issues/${row.id}-${vectorName(vectorId)}.md)`;
}

function failingCoreCell(row: ReportRow, summary: RunSummary): string {
  const failing = summary.results.filter(
    (r) => r.tier === 'core' && (r.status === 'fail' || r.status === 'error'),
  );
  if (failing.length === 0) return 'none';
  return failing.map((r) => issueLink(row, r.id)).join(', ');
}

function requireSummary(results: ReadonlyMap<string, RunSummary>, row: ReportRow): RunSummary {
  const summary = results.get(row.id);
  if (summary === undefined) {
    throw new Error(`renderReport: no result for row "${row.id}"`);
  }
  return summary;
}

function matrixRow(row: ReportRow, summary: RunSummary): string {
  const core = `${countByTierStatus(summary, 'core', 'pass')}/${CORE_IDS.length}`;
  const profileCount = `${countByTierStatus(summary, 'profile', 'pass')}/${PROFILE_IDS.length}`;
  const profile = isThirdParty(row) ? `${profileCount} (info)` : profileCount;
  const notApplicable = String(totalNotApplicable(summary));
  const failing = failingCoreCell(row, summary);
  return `| ${escapeCell(row.implementation)} | ${escapeCell(row.version)} | ${row.language} | ${escapeCell(row.store)} | ${core} | ${profile} | ${notApplicable} | ${failing} |`;
}

function renderMatrix(
  rows: readonly ReportRow[],
  results: ReadonlyMap<string, RunSummary>,
): string[] {
  const lines = [
    '## Matrix',
    '',
    '| Implementation | Version | Language | Store | Core | Profile | N/A | Failing core vectors |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) lines.push(matrixRow(row, requireSummary(results, row)));
  lines.push('');
  return lines;
}

function renderTargetSection(row: ReportRow): string[] {
  const lines = [`### ${row.id}`, '', `- Runner: ${row.kind}`];
  if (row.image !== undefined) lines.push(`- Image: ${row.image}`);
  if (row.packages !== undefined) lines.push(`- Packages: ${row.packages.join(', ')}`);
  if (row.notes !== undefined) lines.push(`- Notes: ${row.notes}`);
  lines.push('');
  return lines;
}

function renderTargets(rows: readonly ReportRow[]): string[] {
  const lines = ['## Targets', ''];
  for (const row of rows) lines.push(...renderTargetSection(row));
  return lines;
}

function detail(result: VectorResult | undefined): string {
  if (result === undefined) return 'no result';
  if (result.status === 'not-applicable' || result.status === 'error') return result.error ?? '';
  const parts: string[] = [];
  for (const step of result.steps)
    for (const failure of step.failures) parts.push(`${step.stepId}: ${failure}`);
  return parts.join('; ');
}

function renderPerVectorTable(row: ReportRow, summary: RunSummary): string[] {
  const lines = [`### ${row.id}`, '', '| Vector | Status | Runner | Detail |', '|---|---|---|---|'];
  for (const vectorId of CORE_IDS) {
    const result = resultFor(summary, vectorId);
    const status = result?.status ?? 'missing';
    const runner = runnerFor(row, vectorId);
    lines.push(`| ${vectorId} | ${status} | ${runner} | ${escapeCell(detail(result))} |`);
  }
  lines.push('');
  return lines;
}

function renderPerVectorDetail(
  rows: readonly ReportRow[],
  results: ReadonlyMap<string, RunSummary>,
): string[] {
  const thirdParty = rows.filter(isThirdParty);
  const lines = ['## Per-vector detail', ''];
  for (const row of thirdParty)
    lines.push(...renderPerVectorTable(row, requireSummary(results, row)));
  return lines;
}

function renderHowGenerated(): string[] {
  return [
    '## How this file is generated',
    '',
    'Two gates check this file. The `ts` job renders it from the committed `conformance/results/*.json` with ' +
      `no containers running (\`bun run report -- --render-only\`) and compares the result to what is ` +
      'committed. The `services` job brings up `test/compose.yml` and `conformance/third-party/compose.yml`, ' +
      `re-runs every row for real, and compares both the fresh results and the fresh render against what is ` +
      `committed (\`bun run report\`). Run \`${REGENERATE_COMMAND}\` locally with both compose files up to ` +
      'regenerate everything.',
    '',
  ];
}

/**
 * REQ-CONF-8: renders conformance/REPORT.md from the row manifest and the collected results. Pure: the same
 * rows and results always render to the same string, with no timestamp, host name, port or duration anywhere
 * in the output.
 */
export function renderReport(
  rows: readonly ReportRow[],
  results: ReadonlyMap<string, RunSummary>,
): string {
  const lines: string[] = [
    '# Cross-implementation conformance report',
    '',
    'This file is generated, not hand written. It is a golden file checked by CI: run ' +
      `\`${REGENERATE_COMMAND}\` to regenerate it from a full run of every row in the manifest, which also ` +
      'rewrites the committed run summaries under `conformance/results/`.',
    '',
    'Third-party implementations are graded on the `core` tier only. Their `profile` numbers are printed for ' +
      "information alongside anyonce's own results and are never a pass or fail judgement of that " +
      'implementation.',
    '',
    ...renderMatrix(rows, results),
    ...renderTargets(rows),
    ...renderPerVectorDetail(rows, results),
    ...renderHowGenerated(),
  ];
  return lines.join('\n');
}
