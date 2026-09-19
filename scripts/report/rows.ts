/**
 * REQ-CONF-8: the row manifest for the cross-implementation report. This is code, not data, so a row that has
 * no committed result, or a committed result with no row, is an error in both directions (report.test.ts and
 * scripts/report.ts check that from the results and REPORT.md sides respectively).
 */

/** How a row's conformance run is produced. */
export type RowKind = 'ts-in-process' | 'ts-url' | 'go-url' | 'workerd-url';

export interface ReportRow {
  /** Stable id; also the results file name (conformance/results/<id>.json) and, for a third-party row, the
   * issue draft prefix (conformance/issues/<id>-<vector-name>.md). */
  id: string;
  implementation: string;
  /** Exact published version, or "this repo" for anyonce. */
  version: string;
  language: 'TypeScript' | 'Go';
  store: string;
  kind: RowKind;
  /** Graded tiers. Third parties are core only (D17). */
  graded: readonly ('core' | 'profile')[];
  capabilities: readonly 'short-ttl'[];
  /** Pinned container image, when this row runs in one. */
  image?: string;
  /** Pinned package versions installed in that container. */
  packages?: readonly string[];
  /** Configuration that departs from the implementation's own defaults, and why. */
  notes?: string;
}

const ANYONCE_GRADED = ['core', 'profile'] as const;
const THIRD_PARTY_GRADED = ['core'] as const;
const SHORT_TTL = ['short-ttl'] as const;

/**
 * REQ-CONF-8 / Q52: the only vector the TypeScript runner cannot discriminate (the Fetch Headers class
 * lowercases every name it is given), so every ts-url row takes that one vector's result from the Go runner
 * instead. render.ts and collect.ts both key off this constant so the rule is stated once.
 */
export const GO_REGRADED_VECTOR_ID = 'core/header-name-case-insensitive';

/** The runner that actually produced a vector's result for this row (Q52). Every other vector is 'ts'. */
export function runnerFor(row: Pick<ReportRow, 'kind'>, vectorId: string): 'ts' | 'go' {
  if (row.kind === 'go-url') return 'go';
  if (row.kind === 'ts-url' && vectorId === GO_REGRADED_VECTOR_ID) return 'go';
  return 'ts';
}

/** D17: a row graded on the core tier only, i.e. one of the three third-party implementations. */
export function isThirdParty(row: Pick<ReportRow, 'graded'>): boolean {
  return row.graded.length === 1 && row.graded[0] === 'core';
}

/**
 * REQ-CONF-8: in this exact order, anyonce TypeScript on memory, Durable Objects, D1, DynamoDB, Redis,
 * Postgres; anyonce Go on memory, DynamoDB, Redis, Postgres, SQLite; then the three third-party rows.
 */
export const ROWS: readonly ReportRow[] = [
  {
    id: 'anyonce-ts-memory',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'TypeScript',
    store: 'memory',
    kind: 'ts-in-process',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-ts-durable-objects',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'TypeScript',
    store: 'durable-objects',
    kind: 'workerd-url',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-ts-d1',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'TypeScript',
    store: 'd1',
    kind: 'workerd-url',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-ts-dynamodb',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'TypeScript',
    store: 'dynamodb',
    kind: 'ts-in-process',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-ts-redis',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'TypeScript',
    store: 'redis',
    kind: 'ts-in-process',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-ts-postgres',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'TypeScript',
    store: 'postgres',
    kind: 'ts-in-process',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-go-memory',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'Go',
    store: 'memory',
    kind: 'go-url',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-go-dynamodb',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'Go',
    store: 'dynamodb',
    kind: 'go-url',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-go-redis',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'Go',
    store: 'redis',
    kind: 'go-url',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-go-postgres',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'Go',
    store: 'postgres',
    kind: 'go-url',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'anyonce-go-sqlite',
    implementation: 'anyonce',
    version: 'this repo',
    language: 'Go',
    store: 'sqlite',
    kind: 'go-url',
    graded: ANYONCE_GRADED,
    capabilities: SHORT_TTL,
  },
  {
    id: 'hono-idempotency',
    implementation: 'hono-idempotency',
    version: '0.9.1',
    language: 'TypeScript',
    store: 'memory',
    kind: 'ts-url',
    graded: THIRD_PARTY_GRADED,
    capabilities: SHORT_TTL,
    image: 'node:22.23.2-alpine',
    packages: [
      'hono-idempotency@0.9.1',
      'hono@4.13.8',
      'hono-problem-details@0.11.0',
      '@hono/node-server@2.1.1',
    ],
    notes:
      'required: true, so the fixture matches core/key-missing-required. methods and ' +
      'dangerouslyAllowGlobalKeys are also set but are inert for this fixture: every route is POST, and the ' +
      'fixture never reuses a key across routes, so neither setting changes what the run measures.',
  },
  {
    id: 'idempo',
    implementation: 'idempo',
    version: 'v1.0.0',
    language: 'Go',
    store: 'in-memory',
    kind: 'ts-url',
    graded: THIRD_PARTY_GRADED,
    capabilities: SHORT_TTL,
    image: 'golang:1.26.8-alpine3.24',
    packages: ['github.com/eben-vranken/idempo@v1.0.0'],
    notes: 'every idempo.Options field left at its default.',
  },
  {
    id: 'fiber',
    implementation: 'fiber',
    version: 'v3.5.0',
    language: 'Go',
    store: 'fiber storage',
    kind: 'ts-url',
    graded: THIRD_PARTY_GRADED,
    capabilities: SHORT_TTL,
    image: 'golang:1.26.8-alpine3.24',
    packages: ['github.com/gofiber/fiber/v3@v3.5.0'],
    notes:
      'KeyHeader overridden from the default X-Idempotency-Key to Idempotency-Key, and KeyHeaderValidate ' +
      'overridden to accept every key, per Q53. Without both overrides every vector fails key validation ' +
      'before the middleware runs at all.',
  },
];
