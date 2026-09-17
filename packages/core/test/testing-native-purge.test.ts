import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../src/memory';
import { type StoreSuiteOptions, storeContractSuite } from '../src/testing/index';
import type { Store } from '../src/types';

/** A backend whose rows are swept by the service itself, so purge has nothing to do (DynamoDB TTL, Redis PEXPIREAT). */
class NativeTtlStore implements Store {
  private readonly inner = new MemoryStore();
  begin: Store['begin'] = (op, opts) => this.inner.begin(op, opts);
  complete: Store['complete'] = (op, fence, result, now) =>
    this.inner.complete(op, fence, result, now);
  abandon: Store['abandon'] = (op, fence) => this.inner.abandon(op, fence);
  get: Store['get'] = (op, now) => this.inner.get(op, now);
  async purge(_now: number): Promise<number> {
    return 0;
  }
}

function registerSuite(
  options: StoreSuiteOptions,
): Array<{ name: string; fn: () => Promise<void> }> {
  const registered: Array<{ name: string; fn: () => Promise<void> }> = [];
  storeContractSuite(
    'native-purge',
    () => ({ store: new NativeTtlStore() }),
    {
      describe: (_n, fn) => fn(),
      test: (name, fn) => {
        registered.push({ name, fn });
      },
      expect,
    },
    options,
  );
  return registered;
}

function purgeTest(registered: Array<{ name: string; fn: () => Promise<void> }>): {
  name: string;
  fn: () => Promise<void>;
} {
  const found = registered.find((t) => t.name.includes('purge'));
  if (found === undefined) throw new Error('no purge test registered');
  return found;
}

describe('contract suite native purge', () => {
  test('REQ-STORE-7: with nativePurge the suite requires purge to return 0 and the expired row to be absent anyway', async () => {
    const found = purgeTest(registerSuite({ nativePurge: true }));
    expect(found.name).toBe(
      'REQ-STORE-7: purge is a no-op that returns 0 because the backend expires rows natively',
    );
    await found.fn();
  });

  test('REQ-STORE-7: without nativePurge the suite still requires purge to remove and count', async () => {
    const found = purgeTest(registerSuite({}));
    expect(found.name).toBe('REQ-STORE-7: purge removes expired records and returns how many');
    let failed = false;
    try {
      await found.fn();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
