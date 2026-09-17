import { describe, expect, test } from 'bun:test';
import { httpFingerprint, jcsFingerprint, sha256Hex } from '../src/fingerprint';

const enc = new TextEncoder();

describe('fingerprints', () => {
  test('REQ-CORE-4: sha256Hex known answers', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('REQ-CORE-4: httpFingerprint hashes method, newline, path, newline, body bytes', async () => {
    const expected = await sha256Hex(enc.encode('POST\n/echo\nhello'));
    expect(await httpFingerprint('POST', '/echo', enc.encode('hello'))).toBe(expected);
    expect(await httpFingerprint('POST', '/echo', enc.encode('hellp'))).not.toBe(expected);
    expect(await httpFingerprint('PATCH', '/echo', enc.encode('hello'))).not.toBe(expected);
    expect(await httpFingerprint('POST', '/echo2', enc.encode('hello'))).not.toBe(expected);
  });

  test('REQ-CORE-4: httpFingerprint with an empty body still includes both separators', async () => {
    expect(await httpFingerprint('POST', '/x', new Uint8Array(0))).toBe(
      await sha256Hex(enc.encode('POST\n/x\n')),
    );
  });

  test('REQ-CORE-4: jcsFingerprint is key order independent and equals the hash of the canonical text', async () => {
    const a = await jcsFingerprint({ b: 1, a: [2, 3] });
    const b = await jcsFingerprint({ a: [2, 3], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(await sha256Hex(enc.encode('{"a":[2,3],"b":1}')));
  });

  test('REQ-CORE-4: jcsFingerprint rejects values JCS cannot serialize', async () => {
    await expect(jcsFingerprint({ a: 10n })).rejects.toThrow('cannot be canonicalized');
  });
});
