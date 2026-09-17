import { formatReport, type ReportFormat } from './report';
import { type RunOptions, runVectors } from './run';
import type { Target } from './target';
import type { RunSummary, Vector } from './types';

export interface ConformanceOptionsWithVectors extends RunOptions {
  target: Target;
  /** Default markdown. */
  report?: ReportFormat;
  vectors: Vector[];
}

export interface ConformanceResult {
  summary: RunSummary;
  report: string;
}

/**
 * REQ-CONF-5: one call for tests and the CLI. Node-free (no node:fs): runtimes without it, such as
 * workerd, import this through the runtime entry and must supply vectors explicitly.
 */
export async function runConformanceWith(
  options: ConformanceOptionsWithVectors,
): Promise<ConformanceResult> {
  const { target, report, vectors, ...runOptions } = options;
  const summary = await runVectors(target, vectors, runOptions);
  const label = typeof target === 'function' ? 'in-process fetch handler' : target.baseUrl;
  return {
    summary,
    report: formatReport(summary, report ?? 'markdown', {
      target: label,
      generatedAt: new Date().toISOString(),
    }),
  };
}
