/** D11 problem codes. missing-principal is the Q18 addition for REQ-HTTP-5; the last two are the Q23 additions for the webhook door. */
export type ProblemCode =
  | 'missing-key'
  | 'invalid-key'
  | 'conflict'
  | 'fingerprint-mismatch'
  | 'payload-too-large'
  | 'store-unavailable'
  | 'missing-principal'
  | 'configuration-error'
  | 'signature-invalid';

/** Q23: a per code title override. The status and the code member are fixed by D11 and are not overridable. */
export type ProblemTitles = Partial<Record<ProblemCode, string>>;

/** RFC 9457 problem details with the anyonce code member (D10). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: ProblemCode;
}

export const DEFAULT_PROBLEM_BASE_URI = 'https://in8.sh/anyonce/problems/';

export const PROBLEM_STATUS: Record<ProblemCode, number> = {
  'missing-key': 400,
  'invalid-key': 400,
  conflict: 409,
  'fingerprint-mismatch': 422,
  'payload-too-large': 413,
  'store-unavailable': 503,
  'missing-principal': 500,
  'configuration-error': 500,
  'signature-invalid': 401,
};

export const PROBLEM_TITLE: Record<ProblemCode, string> = {
  'missing-key': 'The Idempotency-Key header is required for this request',
  'invalid-key': 'The Idempotency-Key header value is not a valid key',
  conflict: 'A request with this Idempotency-Key is still in progress',
  'fingerprint-mismatch': 'This Idempotency-Key was already used with a different request payload',
  'payload-too-large': 'The request body exceeds the size this idempotent endpoint accepts',
  'store-unavailable': 'The idempotency store is unavailable',
  'missing-principal': 'The idempotency scope requires a principal and none was found',
  'configuration-error': 'This endpoint is not configured correctly and cannot accept the request',
  'signature-invalid': 'The request signature could not be verified',
};

export function problem(
  code: ProblemCode,
  baseUri: string,
  detail?: string,
  title?: string,
): Problem {
  const out: Problem = {
    type: `${baseUri}${code}`,
    title: title ?? PROBLEM_TITLE[code],
    status: PROBLEM_STATUS[code],
    code,
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}

/** Serializes a problem as application/problem+json. Extra headers (Link, Retry-After) are set, not appended. */
export function problemResponse(p: Problem, extraHeaders: [string, string][] = []): Response {
  const headers = new Headers({
    'Content-Type': 'application/problem+json',
    'Cache-Control': 'no-store',
  });
  for (const [name, value] of extraHeaders) headers.set(name, value);
  return new Response(JSON.stringify(p), { status: p.status, headers });
}
