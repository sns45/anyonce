import { httpFingerprint, sha256Hex } from '../fingerprint';
import { canonicalize } from '../jcs';
import { type KeySyntax, parseKey } from '../key';
import type { FingerprintFn, FingerprintMode, ResolvedHttpOptions } from './options';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type KeyLookup =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; key: string };

/**
 * REQ-HTTP-2. Headers.get is case-insensitive and joins repeated fields with a comma and a space, so a repeated
 * header fails parseKey on its own (a bare token cannot contain a space; a second quoted string is trailing data).
 */
export function lookupKey(headers: Headers, headerName: string, syntax: KeySyntax): KeyLookup {
  const raw = headers.get(headerName);
  if (raw === null) return { kind: 'missing' };
  const parsed = parseKey(raw, syntax);
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
  return { kind: 'ok', key: parsed.key };
}

/** D9: the path hashed into the fingerprint is pathname plus search. */
export function requestPath(req: Request): string {
  const url = new URL(req.url);
  return url.pathname + url.search;
}

/**
 * D8 default when no router pattern is available. The method is the wire form (RFC 9110 method names are case
 * sensitive) and the pathname keeps its percent encoding, so both match the Go scope.
 */
export function defaultScope(req: Request): string {
  return `${req.method} ${new URL(req.url).pathname}`;
}

export type ScopeResult = { ok: true; scope: string } | { ok: false; code: 'missing-principal' };

export function resolveScope(
  req: Request,
  options: ResolvedHttpOptions,
  routeScope?: string,
): ScopeResult {
  const base = options.scope !== undefined ? options.scope(req) : (routeScope ?? defaultScope(req));
  if (options.principal === undefined) return { ok: true, scope: base };
  const principal = options.principal(req);
  if (principal === undefined || principal === '') {
    if (options.requirePrincipal) return { ok: false, code: 'missing-principal' };
    return { ok: true, scope: base };
  }
  return { ok: true, scope: `${base}#${principal}` };
}

export type BodyRead = { ok: true; body: Uint8Array } | { ok: false; code: 'payload-too-large' };

/** REQ-HTTP-6: reads a clone so the handler still receives an unread body; stops at maxBytes plus one. */
export async function readBody(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    return { ok: false, code: 'payload-too-large' };
  const body = req.clone().body;
  if (body === null) return { ok: true, body: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, code: 'payload-too-large' };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: out };
}

/** D9 and REQ-HTTP-6. The jcs mode falls back to the byte form when the body is not JSON. */
export async function requestFingerprint(
  req: Request,
  body: Uint8Array,
  mode: FingerprintMode | FingerprintFn,
): Promise<string> {
  if (typeof mode === 'function') return await mode(req, body);
  const method = req.method;
  const path = requestPath(req);
  if (mode === 'jcs') {
    let canonical: string | undefined;
    try {
      canonical = canonicalize(JSON.parse(decoder.decode(body)));
    } catch {
      canonical = undefined;
    }
    if (canonical !== undefined)
      return sha256Hex(encoder.encode(`${method}\n${path}\n${canonical}`));
  }
  return httpFingerprint(method, path, body);
}
