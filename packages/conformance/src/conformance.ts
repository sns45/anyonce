import { type ConformanceResult, runConformanceWith } from './conformance-runtime';
import { loadVectors } from './load';
import type { ReportFormat } from './report';
import type { RunOptions } from './run';
import type { Target } from './target';
import type { Vector } from './types';

export interface ConformanceOptions extends RunOptions {
  target: Target;
  /** Default markdown. */
  report?: ReportFormat;
  /** Default: every vector under conformance/vectors. */
  vectors?: Vector[];
}

export type { ConformanceResult };

/** REQ-CONF-5: one call for tests and the CLI; loads every vector under conformance/vectors when none are given. */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceResult> {
  return runConformanceWith({ ...options, vectors: options.vectors ?? loadVectors() });
}
