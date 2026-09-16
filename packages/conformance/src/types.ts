export type Tier = 'core' | 'profile';
export type Capability = 'short-ttl';
export type FixtureName = 'echo' | 'status' | 'slow' | 'large' | 'counter';
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HeaderExpectation = string | { present: true } | { absent: true } | { regex: string };

export interface StepRequest {
  method: Method;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface StepExpect {
  status: number;
  headers?: Record<string, HeaderExpectation>;
  bodyEquals?: string | { sameAs: string };
  bodyJson?: Record<string, string | number | boolean | null>;
  bodyBytes?: number;
  handlerInvocations?: number;
}

export interface Step {
  id: string;
  delayMs?: number;
  concurrentWith?: string[];
  request: StepRequest;
  expect: StepExpect;
}

export interface Vector {
  id: string;
  tier: Tier;
  title: string;
  draftRef?: string;
  description: string;
  requires?: Capability[];
  fixture: FixtureName;
  steps: Step[];
}

export interface ObservedResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface StepOutcome {
  stepId: string;
  failures: string[];
}

export type VectorStatus = 'pass' | 'fail' | 'not-applicable' | 'error';

export interface VectorResult {
  id: string;
  tier: Tier;
  status: VectorStatus;
  steps: StepOutcome[];
  error?: string;
}

export interface RunSummary {
  results: VectorResult[];
  passed: number;
  failed: number;
  notApplicable: number;
  errored: number;
}

export interface EvaluationContext {
  /** Bodies of earlier steps in this vector, by step id, for sameAs. */
  priorBodies: Map<string, Uint8Array>;
  /** Counter value read after the step (and its concurrent group) settled, when the expectation asks for it. */
  handlerInvocations?: number;
}
