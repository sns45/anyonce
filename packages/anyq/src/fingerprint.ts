import { jcsFingerprint, sha256Hex } from '@anyonce/core';
import { FingerprintError } from './errors';

const encoder = new TextEncoder();

/**
 * D9 as amended by Q3: the TypeScript queue fingerprint is total. A string hashes its UTF-8 bytes, a byte body
 * hashes the bytes, and anything else hashes its RFC 8785 canonical form. A body JCS cannot serialize throws
 * FingerprintError. `message.raw` is never used, because that would make the fingerprint provider dependent.
 */
export async function messageFingerprint(body: unknown): Promise<string> {
  if (typeof body === 'string') return sha256Hex(encoder.encode(body));
  if (body instanceof ArrayBuffer) return sha256Hex(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return sha256Hex(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  try {
    return await jcsFingerprint(body);
  } catch (cause) {
    throw new FingerprintError(cause);
  }
}
