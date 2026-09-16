import type { EvaluationContext, HeaderExpectation, ObservedResponse, StepExpect } from './types';

const decoder = new TextDecoder();

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function checkHeader(
  name: string,
  expectation: HeaderExpectation,
  headers: Headers,
): string | undefined {
  const actual = headers.get(name);
  if (typeof expectation === 'string') {
    if (actual === null) return `header ${name}: expected "${expectation}", got absent`;
    if (actual !== expectation) return `header ${name}: expected "${expectation}", got "${actual}"`;
    return undefined;
  }
  if ('present' in expectation) {
    return actual === null ? `header ${name}: expected present, got absent` : undefined;
  }
  if ('absent' in expectation) {
    return actual === null ? undefined : `header ${name}: expected absent, got "${actual}"`;
  }
  const re = new RegExp(expectation.regex);
  if (actual === null) return `header ${name}: expected /${expectation.regex}/, got absent`;
  if (!re.test(actual)) return `header ${name}: expected /${expectation.regex}/, got "${actual}"`;
  return undefined;
}

function checkBodyEquals(
  expected: string | { sameAs: string },
  body: Uint8Array,
  ctx: EvaluationContext,
): string | undefined {
  if (typeof expected === 'string') {
    const actual = decoder.decode(body);
    return actual === expected ? undefined : `body: expected "${expected}", got "${actual}"`;
  }
  const prior = ctx.priorBodies.get(expected.sameAs);
  if (prior === undefined) return `body: sameAs references unknown step ${expected.sameAs}`;
  if (bytesEqual(prior, body)) return undefined;
  return `body: expected same bytes as step ${expected.sameAs} (${prior.byteLength} bytes), got ${body.byteLength} bytes that differ`;
}

function checkBodyJson(expected: Record<string, unknown>, body: Uint8Array): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch {
    return ['body: expected JSON object, got unparseable body'];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ['body: expected JSON object, got non-object'];
  }
  const record = parsed as Record<string, unknown>;
  const failures: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      failures.push(
        `body.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(record[key])}`,
      );
    }
  }
  return failures;
}

/** Returns a list of human readable failures; empty means the observed response satisfies the expectation. */
export function evaluateExpect(
  expect: StepExpect,
  observed: ObservedResponse,
  ctx: EvaluationContext,
): string[] {
  const failures: string[] = [];
  if (observed.status !== expect.status) {
    failures.push(`status: expected ${expect.status}, got ${observed.status}`);
  }
  for (const [name, expectation] of Object.entries(expect.headers ?? {})) {
    const failure = checkHeader(name, expectation, observed.headers);
    if (failure) failures.push(failure);
  }
  if (expect.bodyEquals !== undefined) {
    const failure = checkBodyEquals(expect.bodyEquals, observed.body, ctx);
    if (failure) failures.push(failure);
  }
  if (expect.bodyJson !== undefined) {
    failures.push(...checkBodyJson(expect.bodyJson, observed.body));
  }
  if (expect.bodyBytes !== undefined && observed.body.byteLength !== expect.bodyBytes) {
    failures.push(`body: expected ${expect.bodyBytes} bytes, got ${observed.body.byteLength}`);
  }
  if (expect.handlerInvocations !== undefined) {
    if (ctx.handlerInvocations === undefined) {
      failures.push('handlerInvocations: counter unavailable');
    } else if (ctx.handlerInvocations !== expect.handlerInvocations) {
      failures.push(
        `handlerInvocations: expected ${expect.handlerInvocations}, got ${ctx.handlerInvocations}`,
      );
    }
  }
  return failures;
}
