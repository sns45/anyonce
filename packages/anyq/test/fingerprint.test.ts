import { describe, expect, test } from 'bun:test';
import { jcsFingerprint, sha256Hex } from '@anyonce/core';
import { FingerprintError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';

const encoder = new TextEncoder();

describe('message fingerprint', () => {
  test('REQ-Q-1: a string body hashes its UTF-8 bytes', async () => {
    await expect(messageFingerprint('hello')).resolves.toBe(
      await sha256Hex(encoder.encode('hello')),
    );
  });

  test('REQ-Q-1: byte bodies hash the bytes directly', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const expected = await sha256Hex(bytes);
    await expect(messageFingerprint(bytes)).resolves.toBe(expected);
    await expect(messageFingerprint(bytes.buffer)).resolves.toBe(expected);
    await expect(messageFingerprint(new DataView(bytes.buffer))).resolves.toBe(expected);
  });

  test('REQ-Q-1: an object body hashes its RFC 8785 form, so key order does not matter', async () => {
    const a = await messageFingerprint({ b: 2, a: 1 });
    const b = await messageFingerprint({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe(await jcsFingerprint({ a: 1, b: 2 }));
  });

  test('REQ-Q-1: a body JCS cannot serialize throws FingerprintError, never a silent fallback', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(messageFingerprint(cyclic)).rejects.toBeInstanceOf(FingerprintError);
    await expect(messageFingerprint(10n)).rejects.toBeInstanceOf(FingerprintError);
  });
});
