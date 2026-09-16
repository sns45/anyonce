import { describe, expect, test } from 'bun:test';
import { evaluateExpect } from '../src/expect';
import type { EvaluationContext, ObservedResponse } from '../src/types';

const enc = new TextEncoder();

function observed(status: number, headers: Record<string, string>, body = ''): ObservedResponse {
  return { status, headers: new Headers(headers), body: enc.encode(body) };
}

function ctx(extra: Partial<EvaluationContext> = {}): EvaluationContext {
  return { priorBodies: new Map(), ...extra };
}

describe('evaluateExpect', () => {
  test('REQ-CONF-1: status mismatch is reported with expected and actual', () => {
    expect(evaluateExpect({ status: 201 }, observed(200, {}), ctx())).toEqual([
      'status: expected 201, got 200',
    ]);
  });

  test('REQ-CONF-1: exact header match is case-insensitive on the name and exact on the value', () => {
    const ok = evaluateExpect(
      { status: 200, headers: { 'idempotency-replayed': 'true' } },
      observed(200, { 'Idempotency-Replayed': 'true' }),
      ctx(),
    );
    expect(ok).toEqual([]);
    const bad = evaluateExpect(
      { status: 200, headers: { 'Idempotency-Replayed': 'true' } },
      observed(200, { 'Idempotency-Replayed': 'True' }),
      ctx(),
    );
    expect(bad).toEqual(['header Idempotency-Replayed: expected "true", got "True"']);
  });

  test('REQ-CONF-1: present, absent and regex header expectations', () => {
    const res = observed(409, { 'Retry-After': '3', 'Content-Type': 'application/problem+json' });
    expect(
      evaluateExpect({ status: 409, headers: { 'Retry-After': { present: true } } }, res, ctx()),
    ).toEqual([]);
    expect(
      evaluateExpect(
        { status: 409, headers: { 'Idempotency-Replayed': { absent: true } } },
        res,
        ctx(),
      ),
    ).toEqual([]);
    expect(
      evaluateExpect(
        { status: 409, headers: { 'Retry-After': { regex: '^[1-9][0-9]*$' } } },
        res,
        ctx(),
      ),
    ).toEqual([]);
    expect(
      evaluateExpect({ status: 409, headers: { 'Content-Type': { absent: true } } }, res, ctx()),
    ).toEqual(['header Content-Type: expected absent, got "application/problem+json"']);
    expect(
      evaluateExpect({ status: 409, headers: { 'X-Missing': { present: true } } }, res, ctx()),
    ).toEqual(['header X-Missing: expected present, got absent']);
    expect(
      evaluateExpect({ status: 409, headers: { 'Retry-After': { regex: '^0$' } } }, res, ctx()),
    ).toEqual(['header Retry-After: expected /^0$/, got "3"']);
  });

  test('REQ-CONF-1: bodyEquals compares the utf8 body and sameAs compares bytes with an earlier step', () => {
    expect(
      evaluateExpect({ status: 200, bodyEquals: 'hello' }, observed(200, {}, 'hello'), ctx()),
    ).toEqual([]);
    expect(
      evaluateExpect({ status: 200, bodyEquals: 'hello' }, observed(200, {}, 'bye'), ctx()),
    ).toEqual(['body: expected "hello", got "bye"']);
    const prior = new Map([['first', enc.encode('hello')]]);
    expect(
      evaluateExpect(
        { status: 200, bodyEquals: { sameAs: 'first' } },
        observed(200, {}, 'hello'),
        ctx({ priorBodies: prior }),
      ),
    ).toEqual([]);
    expect(
      evaluateExpect(
        { status: 200, bodyEquals: { sameAs: 'first' } },
        observed(200, {}, 'other'),
        ctx({ priorBodies: prior }),
      ),
    ).toEqual(['body: expected same bytes as step first (5 bytes), got 5 bytes that differ']);
    expect(
      evaluateExpect(
        { status: 200, bodyEquals: { sameAs: 'nope' } },
        observed(200, {}, 'x'),
        ctx(),
      ),
    ).toEqual(['body: sameAs references unknown step nope']);
  });

  test('REQ-CONF-1: bodyJson checks top-level members and reports parse errors', () => {
    expect(
      evaluateExpect(
        { status: 400, bodyJson: { code: 'missing-key' } },
        observed(400, {}, '{"code":"missing-key","title":"x"}'),
        ctx(),
      ),
    ).toEqual([]);
    expect(
      evaluateExpect(
        { status: 400, bodyJson: { code: 'missing-key' } },
        observed(400, {}, '{"code":"other"}'),
        ctx(),
      ),
    ).toEqual(['body.code: expected "missing-key", got "other"']);
    expect(
      evaluateExpect(
        { status: 400, bodyJson: { code: 'missing-key' } },
        observed(400, {}, 'not json'),
        ctx(),
      ),
    ).toEqual(['body: expected JSON object, got unparseable body']);
    expect(
      evaluateExpect(
        { status: 200, bodyJson: { count: 1 } },
        observed(200, {}, '{"count":0}'),
        ctx(),
      ),
    ).toEqual(['body.count: expected 1, got 0']);
  });

  test('REQ-CONF-1: bodyBytes checks the byte length', () => {
    expect(
      evaluateExpect({ status: 200, bodyBytes: 5 }, observed(200, {}, 'hello'), ctx()),
    ).toEqual([]);
    expect(
      evaluateExpect({ status: 200, bodyBytes: 0 }, observed(200, {}, 'hello'), ctx()),
    ).toEqual(['body: expected 0 bytes, got 5']);
  });

  test('REQ-CONF-1: handlerInvocations compares against the counter read by the runner', () => {
    expect(
      evaluateExpect(
        { status: 200, handlerInvocations: 1 },
        observed(200, {}),
        ctx({ handlerInvocations: 1 }),
      ),
    ).toEqual([]);
    expect(
      evaluateExpect(
        { status: 200, handlerInvocations: 1 },
        observed(200, {}),
        ctx({ handlerInvocations: 2 }),
      ),
    ).toEqual(['handlerInvocations: expected 1, got 2']);
    expect(
      evaluateExpect({ status: 200, handlerInvocations: 1 }, observed(200, {}), ctx()),
    ).toEqual(['handlerInvocations: counter unavailable']);
  });

  test('REQ-CONF-1: all failures are collected, not just the first', () => {
    const out = evaluateExpect(
      { status: 201, bodyEquals: 'a', headers: { 'X-A': 'b' } },
      observed(200, {}, 'z'),
      ctx(),
    );
    expect(out).toHaveLength(3);
  });

  test('REQ-CONF-1: a malformed header regex yields a failure string instead of throwing', () => {
    expect(
      evaluateExpect(
        { status: 200, headers: { 'X-A': { regex: '(' } } },
        observed(200, { 'X-A': 'v' }),
        ctx(),
      ),
    ).toEqual(['header X-A: invalid regex /(/']);
  });
});
