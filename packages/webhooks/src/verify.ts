/**
 * REQ-WH-6: the Standard Webhooks signature check, Web APIs only. The wire format is recorded in
 * docs/reference/anyhook-signing.md and this implementation is byte compatible with the anyhook signer, which
 * itself round trips against the reference standardwebhooks package.
 */

/** The optional prefix on a Standard Webhooks secret. */
export const SECRET_PREFIX = 'whsec_';

/** The tolerance the specification names, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface StandardWebhooksOptions {
  /** Absolute difference between now and the header timestamp, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Epoch milliseconds, for tests. Default Date.now. */
  clock?: () => number;
}

const encoder = new TextEncoder();

function base64ToBytes(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Strips the whsec_ prefix and decodes the standard base64 remainder. Throws on a secret that
 * cannot decode, and throws separately on a secret that decodes to zero bytes (an empty string or
 * the bare prefix), since an empty HMAC key is a configuration error the same way, not a request
 * that should ever reach crypto.subtle.importKey.
 */
export function parseSecret(secret: string): Uint8Array {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const bytes = base64ToBytes(raw);
  if (bytes === undefined) throw new TypeError('anyonce: the webhook secret is not valid base64');
  if (bytes.byteLength === 0) throw new TypeError('anyonce: the webhook secret is empty');
  return bytes;
}

/** Constant time byte comparison: every byte is read whatever the first difference is. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function standardWebhooksVerify(
  secret: string | string[],
  options: StandardWebhooksOptions = {},
): (req: Request, body: Uint8Array) => Promise<boolean> {
  const secrets = (Array.isArray(secret) ? secret : [secret]).map(parseSecret);
  if (secrets.length === 0)
    throw new TypeError('anyonce: standardWebhooksVerify needs at least one secret');
  const tolerance = (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  const clock = options.clock ?? Date.now;
  const keys = secrets.map((raw) =>
    crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]),
  );

  return async (req, body) => {
    const id = req.headers.get('webhook-id');
    const timestamp = req.headers.get('webhook-timestamp');
    const signature = req.headers.get('webhook-signature');
    if (id === null || timestamp === null || signature === null) return false;

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return false;
    if (Math.abs(clock() - Math.trunc(seconds) * 1000) > tolerance) return false;

    const presented: Uint8Array[] = [];
    for (const entry of signature.split(' ')) {
      if (!entry.startsWith('v1,')) continue;
      const bytes = base64ToBytes(entry.slice(3));
      if (bytes !== undefined) presented.push(bytes);
    }
    if (presented.length === 0) return false;

    const prefix = encoder.encode(`${id}.${Math.trunc(seconds)}.`);
    const content = new Uint8Array(prefix.byteLength + body.byteLength);
    content.set(prefix, 0);
    content.set(body, prefix.byteLength);

    let matched = false;
    for (const keyPromise of keys) {
      const mac = new Uint8Array(
        await crypto.subtle.sign('HMAC', await keyPromise, content as BufferSource),
      );
      for (const candidate of presented) if (equalBytes(mac, candidate)) matched = true;
    }
    return matched;
  };
}
