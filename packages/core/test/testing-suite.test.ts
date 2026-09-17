import { describe, expect, test } from 'bun:test';
import { storeContractSuite } from '../src/testing/index';
import type { Store } from '../src/types';

/** A store that violates REQ-STORE-1 on purpose: begin never acquires. */
const brokenStore: Store = {
  begin: async () => ({ outcome: 'in_flight', leaseUntil: 0 }),
  complete: async () => 'not_found',
  abandon: async () => 'not_found',
  get: async () => null,
  purge: async () => 0,
};

describe('storeContractSuite harness', () => {
  test('REQ-STORE-1: the suite registers one test per contract requirement and fails a broken store', async () => {
    const registered: Array<{ name: string; fn: () => Promise<void> }> = [];
    storeContractSuite('broken', () => ({ store: brokenStore }), {
      describe: (_name, fn) => fn(),
      test: (name, fn) => {
        registered.push({ name, fn });
      },
      expect,
    });
    const ids = new Set(registered.map((t) => /^(REQ-STORE-\d+)/.exec(t.name)?.[1]));
    for (let n = 1; n <= 11; n++) expect(ids.has(`REQ-STORE-${n}`)).toBe(true);
    const first = registered.find((t) => t.name.startsWith('REQ-STORE-1:'));
    expect(first).toBeTruthy();
    let failed = false;
    try {
      await first?.fn();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
