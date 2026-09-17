import { parseSfString } from './sfstring';

export const MAX_KEY_BYTES = 255;

export type KeySyntax = 'lenient' | 'strict';
export type KeyValidation = { ok: true } | { ok: false; reason: string };
export type ParseKeyResult =
  | { ok: true; key: string }
  | { ok: false; code: 'invalid-key'; reason: string };

/** REQ-CORE-2: 1 to 255 bytes of printable ASCII (0x21..0x7E); space (0x20) only when the key came from an sf-string. */
export function validateKey(key: string, allowSpace = false): KeyValidation {
  if (key.length === 0) return { ok: false, reason: 'key is empty' };
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code === 0x20 && allowSpace) continue;
    if (code < 0x21 || code > 0x7e)
      return {
        ok: false,
        reason: `key contains a character outside printable ASCII at index ${i}`,
      };
  }
  if (key.length > MAX_KEY_BYTES)
    return { ok: false, reason: `key exceeds ${MAX_KEY_BYTES} bytes` };
  return { ok: true };
}

function invalid(reason: string): ParseKeyResult {
  return { ok: false, code: 'invalid-key', reason };
}

function trimOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charCodeAt(start) === 0x20 || value.charCodeAt(start) === 0x09))
    start++;
  while (end > start && (value.charCodeAt(end - 1) === 0x20 || value.charCodeAt(end - 1) === 0x09))
    end--;
  return value.slice(start, end);
}

/**
 * D7: lenient accepts a bare token or a quoted sf-string (quotes stripped, escapes unescaped); strict accepts only an
 * sf-string. Either way the resulting key must satisfy validateKey; space is allowed only inside an sf-string.
 */
export function parseKey(headerValue: string, syntax: KeySyntax): ParseKeyResult {
  const trimmed = trimOws(headerValue);
  const quoted = trimmed.charCodeAt(0) === 0x22;
  if (syntax === 'strict' || quoted) {
    const parsed = parseSfString(trimmed);
    if (!parsed.ok) return invalid(parsed.reason);
    const validation = validateKey(parsed.value, true);
    if (!validation.ok) return invalid(validation.reason);
    return { ok: true, key: parsed.value };
  }
  const validation = validateKey(trimmed, false);
  if (!validation.ok) return invalid(validation.reason);
  return { ok: true, key: trimmed };
}
