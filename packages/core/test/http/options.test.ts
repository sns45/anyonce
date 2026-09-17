import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_METHODS,
  DEFAULT_STORED_HEADERS,
  resolveHttpOptions,
} from '../../src/http/options';
import { MemoryStore } from '../../src/memory';

describe('resolveHttpOptions', () => {
  const store = new MemoryStore();

  test('REQ-HTTP-1: the default methods are POST and PATCH, matched case-insensitively', () => {
    expect(DEFAULT_METHODS).toEqual(['POST', 'PATCH']);
    const resolved = resolveHttpOptions({ store, methods: ['put', 'Delete'] });
    expect([...resolved.methods]).toEqual(['PUT', 'DELETE']);
    expect([...resolveHttpOptions({ store }).methods]).toEqual(['POST', 'PATCH']);
  });

  test('REQ-HTTP-2: the header name defaults to Idempotency-Key', () => {
    expect(DEFAULT_HEADER_NAME).toBe('Idempotency-Key');
    expect(resolveHttpOptions({ store }).headerName).toBe('Idempotency-Key');
    expect(resolveHttpOptions({ store, headerName: 'X-Request-Key' }).headerName).toBe(
      'X-Request-Key',
    );
  });

  test('REQ-HTTP-3: required defaults to false', () => {
    expect(resolveHttpOptions({ store }).required).toBe(false);
  });

  test('REQ-HTTP-4: key syntax defaults to lenient', () => {
    expect(resolveHttpOptions({ store }).keySyntax).toBe('lenient');
    expect(resolveHttpOptions({ store, keySyntax: 'strict' }).keySyntax).toBe('strict');
  });

  test('REQ-HTTP-5: requirePrincipal without a principal function throws at construction', () => {
    expect(() => resolveHttpOptions({ store, requirePrincipal: true })).toThrow(/requirePrincipal/);
    expect(
      resolveHttpOptions({ store, requirePrincipal: true, principal: () => 'p' }).requirePrincipal,
    ).toBe(true);
  });

  test('REQ-HTTP-6: fingerprint defaults to body and maxRequestBytes to 1 MiB', () => {
    expect(DEFAULT_MAX_REQUEST_BYTES).toBe(1_048_576);
    const resolved = resolveHttpOptions({ store });
    expect(resolved.fingerprint).toBe('body');
    expect(resolved.maxRequestBytes).toBe(1_048_576);
  });

  test('REQ-HTTP-8: the stored header allowlist defaults to five headers, lowercased', () => {
    expect(DEFAULT_STORED_HEADERS).toEqual([
      'Content-Type',
      'Content-Language',
      'Location',
      'ETag',
      'Link',
    ]);
    expect([...resolveHttpOptions({ store }).storeHeaders]).toEqual([
      'content-type',
      'content-language',
      'location',
      'etag',
      'link',
    ]);
    expect([...resolveHttpOptions({ store, storeHeaders: ['X-Trace'] }).storeHeaders]).toEqual([
      'x-trace',
    ]);
  });

  test('REQ-HTTP-13: the problem base URI and docs URL have D11 defaults', () => {
    const resolved = resolveHttpOptions({ store });
    expect(resolved.problemBaseUri).toBe('https://in8.sh/anyonce/problems/');
    expect(resolved.docsUrl).toBe('https://in8.sh/anyonce/problems/missing-key');
    expect(resolveHttpOptions({ store, problemBaseUri: 'https://p.test/' }).docsUrl).toBe(
      'https://p.test/missing-key',
    );
  });

  test('REQ-HTTP-12: engine policy fields flow into the policy with 3.3 defaults', () => {
    const hooks = {};
    const resolved = resolveHttpOptions({ store, ttlMs: 2000, onStoreError: 'fail-open', hooks });
    expect(resolved.policy.ttlMs).toBe(2000);
    expect(resolved.policy.leaseMs).toBe(30_000);
    expect(resolved.policy.maxResultBytes).toBe(1_048_576);
    expect(resolved.policy.onStoreError).toBe('fail-open');
    expect(resolved.policy.hooks).toBe(hooks);
    expect(resolveHttpOptions({ store }).policy.onStoreError).toBe('fail-closed');
  });
});
