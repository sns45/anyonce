import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../src/memory';
import { storeContractSuite } from '../src/testing/index';

describe('contract suite cap', () => {
  test('REQ-STORE-11: the suite reads maxResultBytes from the harness and defaults to 1 MiB', async () => {
    const seen: string[] = [];
    let bodyLength = 0;
    const runner = {
      describe: (_n: string, fn: () => void) => fn(),
      test: (name: string, _fn: () => Promise<void>) => {
        if (name.startsWith('REQ-STORE-11')) seen.push(name);
      },
      expect: () => ({
        toBe() {},
        toEqual() {},
        toBeNull() {},
        toBeUndefined() {},
        toBeGreaterThan() {},
      }),
    };
    storeContractSuite('cap', () => ({ store: new MemoryStore(), maxResultBytes: 4096 }), runner, {
      maxResultBytes: 4096,
    });
    expect(seen).toEqual([
      'REQ-STORE-11: a body of exactly maxResultBytes (4096 bytes) round trips byte-exact',
    ]);
    storeContractSuite('default', () => ({ store: new MemoryStore() }), {
      ...runner,
      test: (name: string) => {
        if (name.startsWith('REQ-STORE-11')) bodyLength = Number(/\((\d+) bytes\)/.exec(name)?.[1]);
      },
    });
    expect(bodyLength).toBe(1_048_576);
  });

  test('REQ-STORE-11: the capped suite body actually round trips at the declared cap', async () => {
    const registered: Array<{ name: string; fn: () => Promise<void> }> = [];
    storeContractSuite(
      'cap-run',
      () => ({ store: new MemoryStore(), maxResultBytes: 4096 }),
      {
        describe: (_n, fn) => fn(),
        test: (name, fn) => {
          registered.push({ name, fn });
        },
        expect,
      },
      { maxResultBytes: 4096 },
    );
    const capped = registered.find((t) => t.name.startsWith('REQ-STORE-11'));
    expect(capped).toBeTruthy();
    await capped?.fn();
  });
});
