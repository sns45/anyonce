import { describe, expect, test } from 'bun:test';
import { formatReport } from '../src/report';
import type { RunSummary } from '../src/types';

const summary: RunSummary = {
  results: [
    {
      id: 'core/post-executes-once',
      tier: 'core',
      status: 'pass',
      steps: [{ stepId: 'first', failures: [] }],
    },
    {
      id: 'core/retry-replays',
      tier: 'core',
      status: 'fail',
      steps: [
        { stepId: 'first', failures: [] },
        {
          stepId: 'retry',
          failures: ['status: expected 201, got 409', 'handlerInvocations: expected 1, got 2'],
        },
      ],
    },
    {
      id: 'core/expiry-executes-again',
      tier: 'core',
      status: 'not-applicable',
      steps: [],
      error: 'requires short-ttl',
    },
    {
      id: 'profile/replayed-header',
      tier: 'profile',
      status: 'error',
      steps: [],
      error: 'reset returned 500',
    },
  ],
  passed: 1,
  failed: 1,
  notApplicable: 1,
  errored: 1,
};

describe('formatReport', () => {
  test('REQ-CONF-5: json is the summary itself plus the target and the time', () => {
    const parsed = JSON.parse(
      formatReport(summary, 'json', { target: 'http://x', generatedAt: '2026-09-17T00:00:00Z' }),
    );
    expect(parsed.target).toBe('http://x');
    expect(parsed.generatedAt).toBe('2026-09-17T00:00:00Z');
    expect(parsed.passed).toBe(1);
    expect(parsed.results).toHaveLength(4);
  });

  test('REQ-CONF-5: markdown has a summary line and one table row per vector with the failures', () => {
    const md = formatReport(summary, 'markdown', { target: 'http://x' });
    expect(md).toContain('# anyonce conformance report');
    expect(md).toContain('Target: http://x');
    expect(md).toContain('1 passed, 1 failed, 1 not applicable, 1 errored');
    expect(md).toContain('| Vector | Tier | Status | Details |');
    expect(md).toContain('| core/post-executes-once | core | pass |  |');
    expect(md).toContain(
      '| core/retry-replays | core | fail | retry: status: expected 201, got 409; retry: handlerInvocations: expected 1, got 2 |',
    );
    expect(md).toContain(
      '| core/expiry-executes-again | core | not-applicable | requires short-ttl |',
    );
    expect(md).toContain('| profile/replayed-header | profile | error | reset returned 500 |');
  });

  test('REQ-CONF-5: junit has one testcase per vector with failure, skipped and error elements', () => {
    const xml = formatReport(summary, 'junit');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      '<testsuite name="anyonce-conformance" tests="4" failures="1" errors="1" skipped="1">',
    );
    expect(xml).toContain('<testcase classname="core" name="core/post-executes-once"/>');
    expect(xml).toContain(
      '<testcase classname="core" name="core/retry-replays"><failure message="retry: status: expected 201, got 409; retry: handlerInvocations: expected 1, got 2"/></testcase>',
    );
    expect(xml).toContain(
      '<testcase classname="core" name="core/expiry-executes-again"><skipped message="requires short-ttl"/></testcase>',
    );
    expect(xml).toContain(
      '<testcase classname="profile" name="profile/replayed-header"><error message="reset returned 500"/></testcase>',
    );
  });

  test('REQ-CONF-5: junit escapes XML special characters in messages', () => {
    const xml = formatReport(
      {
        results: [
          {
            id: 'core/x',
            tier: 'core',
            status: 'fail',
            steps: [{ stepId: 's', failures: ['body: expected "<a&b>"'] }],
          },
        ],
        passed: 0,
        failed: 1,
        notApplicable: 0,
        errored: 0,
      },
      'junit',
    );
    expect(xml).toContain('message="s: body: expected &quot;&lt;a&amp;b&gt;&quot;"');
  });
});
