import type { RunSummary, VectorResult } from './types';

export type ReportFormat = 'json' | 'markdown' | 'junit';

export interface ReportMeta {
  target?: string;
  generatedAt?: string;
}

function details(result: VectorResult): string {
  if (result.status === 'not-applicable' || result.status === 'error') return result.error ?? '';
  const out: string[] = [];
  for (const step of result.steps)
    for (const failure of step.failures) out.push(`${step.stepId}: ${failure}`);
  return out.join('; ');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdown(summary: RunSummary, meta: ReportMeta): string {
  const lines = ['# anyonce conformance report', ''];
  if (meta.target !== undefined) lines.push(`Target: ${meta.target}`, '');
  lines.push(
    `${summary.passed} passed, ${summary.failed} failed, ${summary.notApplicable} not applicable, ${summary.errored} errored`,
    '',
    '| Vector | Tier | Status | Details |',
    '|---|---|---|---|',
  );
  for (const result of summary.results) {
    lines.push(
      `| ${result.id} | ${result.tier} | ${result.status} | ${details(result).replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function testcase(result: VectorResult): string {
  const open = `<testcase classname="${result.tier}" name="${escapeXml(result.id)}"`;
  const message = escapeXml(details(result));
  switch (result.status) {
    case 'pass':
      return `${open}/>`;
    case 'fail':
      return `${open}><failure message="${message}"/></testcase>`;
    case 'not-applicable':
      return `${open}><skipped message="${message}"/></testcase>`;
    case 'error':
      return `${open}><error message="${message}"/></testcase>`;
  }
}

function junit(summary: RunSummary): string {
  const cases = summary.results.map(testcase);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="anyonce-conformance" tests="${summary.results.length}" failures="${summary.failed}" errors="${summary.errored}" skipped="${summary.notApplicable}">`,
    ...cases.map((c) => `  ${c}`),
    '</testsuite>',
    '',
  ].join('\n');
}

/** REQ-CONF-5: the three report formats share one summary shape. */
export function formatReport(
  summary: RunSummary,
  format: ReportFormat,
  meta: ReportMeta = {},
): string {
  switch (format) {
    case 'json':
      return JSON.stringify({ ...meta, ...summary }, null, 2);
    case 'markdown':
      return markdown(summary, meta);
    case 'junit':
      return junit(summary);
  }
}
