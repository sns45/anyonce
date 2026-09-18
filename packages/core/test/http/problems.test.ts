import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROBLEM_BASE_URI,
  PROBLEM_STATUS,
  problem,
  problemResponse,
} from '../../src/http/problems';

describe('problem details', () => {
  test('REQ-HTTP-13: every code maps to its D11 status', () => {
    expect(PROBLEM_STATUS).toEqual({
      'missing-key': 400,
      'invalid-key': 400,
      conflict: 409,
      'fingerprint-mismatch': 422,
      'payload-too-large': 413,
      'store-unavailable': 503,
      'missing-principal': 500,
      'configuration-error': 500,
      'signature-invalid': 401,
    });
  });

  test('REQ-HTTP-13: problem builds type from the base URI and the code', () => {
    const p = problem('conflict', DEFAULT_PROBLEM_BASE_URI);
    expect(p).toEqual({
      type: 'https://in8.sh/anyonce/problems/conflict',
      title: 'A request with this Idempotency-Key is still in progress',
      status: 409,
      code: 'conflict',
    });
    expect(problem('invalid-key', 'https://example.test/p/', 'key is empty').detail).toBe(
      'key is empty',
    );
  });

  test('REQ-HTTP-13: problemResponse is application/problem+json with the members and extra headers', async () => {
    const res = problemResponse(problem('missing-key', DEFAULT_PROBLEM_BASE_URI), [
      ['Link', '<https://docs.test/keys>; rel="describedby"'],
    ]);
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Link')).toBe('<https://docs.test/keys>; rel="describedby"');
    expect(await res.json()).toEqual({
      type: 'https://in8.sh/anyonce/problems/missing-key',
      title: 'The Idempotency-Key header is required for this request',
      status: 400,
      code: 'missing-key',
    });
  });

  test('REQ-WH-2: configuration-error is a 500 and signature-invalid is a 401', () => {
    expect(PROBLEM_STATUS['configuration-error']).toBe(500);
    expect(PROBLEM_STATUS['signature-invalid']).toBe(401);
    expect(problem('configuration-error', DEFAULT_PROBLEM_BASE_URI).type).toBe(
      'https://in8.sh/anyonce/problems/configuration-error',
    );
    expect(problem('signature-invalid', DEFAULT_PROBLEM_BASE_URI).code).toBe('signature-invalid');
  });

  test('REQ-WH-2: a title override replaces the title and leaves the status and the code alone', () => {
    const p = problem(
      'conflict',
      DEFAULT_PROBLEM_BASE_URI,
      undefined,
      'A delivery with this webhook-id is still in progress',
    );
    expect(p.title).toBe('A delivery with this webhook-id is still in progress');
    expect(p.status).toBe(409);
    expect(p.code).toBe('conflict');
    expect(p.type).toBe('https://in8.sh/anyonce/problems/conflict');
  });
});
