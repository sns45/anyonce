import { loadVectors } from './load';
import { formatReport, type ReportFormat } from './report';
import { type RunOptions, runVectors } from './run';
import type { Target } from './target';
import type { RunSummary, Vector } from './types';

export interface ConformanceOptions extends RunOptions {
  target: Target;
  /** Default markdown. */
  report?: ReportFormat;
  /** Default: every vector under conformance/vectors. */
  vectors?: Vector[];
}

export interface ConformanceResult {
  summary: RunSummary;
  report: string;
}

/** REQ-CONF-5: one call for tests and the CLI. */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceResult> {
  const { target, report, vectors, ...runOptions } = options;
  const summary = await runVectors(target, vectors ?? loadVectors(), runOptions);
  const label = typeof target === 'function' ? 'in-process fetch handler' : target.baseUrl;
  return {
    summary,
    report: formatReport(summary, report ?? 'markdown', {
      target: label,
      generatedAt: new Date().toISOString(),
    }),
  };
}
