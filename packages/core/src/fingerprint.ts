import { canonicalize } from './jcs';

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Lowercase hex SHA-256 of the given bytes via Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** D9 default HTTP fingerprint: SHA-256 over method, LF, path, LF, body bytes. The method is hashed as given. */
export async function httpFingerprint(
  method: string,
  path: string,
  body: Uint8Array,
): Promise<string> {
  const prefix = encoder.encode(`${method}\n${path}\n`);
  const joined = new Uint8Array(prefix.byteLength + body.byteLength);
  joined.set(prefix, 0);
  joined.set(body, prefix.byteLength);
  return sha256Hex(joined);
}

/** SHA-256 over the RFC 8785 canonical form of a JSON value. Rejects values JCS cannot serialize. */
export async function jcsFingerprint(json: unknown): Promise<string> {
  return sha256Hex(encoder.encode(canonicalize(json)));
}
