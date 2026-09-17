import { describe, expect, test } from 'bun:test';
import { MAX_KEY_BYTES, parseKey, validateKey } from '../src/key';

describe('validateKey', () => {
  test('REQ-CORE-2: accepts printable ASCII from 1 to 255 bytes', () => {
    expect(validateKey('a')).toEqual({ ok: true });
    expect(validateKey('!~')).toEqual({ ok: true });
    expect(validateKey('a'.repeat(MAX_KEY_BYTES))).toEqual({ ok: true });
  });

  const rejected: Array<[string, string, string]> = [
    ['empty', '', 'empty'],
    ['256 bytes', 'a'.repeat(256), 'exceeds 255'],
    ['space without sf-string', 'a b', 'outside printable ASCII'],
    ['control char', 'a\x01b', 'outside printable ASCII'],
    ['tab', 'a\tb', 'outside printable ASCII'],
    ['DEL', 'a\x7fb', 'outside printable ASCII'],
    ['non-ASCII', 'café', 'outside printable ASCII'],
    ['emoji', 'k\u{1F600}', 'outside printable ASCII'],
  ];
  for (const [label, key, reason] of rejected) {
    test(`REQ-CORE-2: rejects ${label}`, () => {
      const result = validateKey(key);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    });
  }

  test('REQ-CORE-2: allows space only when allowSpace is set', () => {
    expect(validateKey('a b', true)).toEqual({ ok: true });
    expect(validateKey(' ', true)).toEqual({ ok: true });
    expect(validateKey('a b', false).ok).toBe(false);
  });
});

describe('parseKey', () => {
  test('REQ-CORE-2: lenient accepts a bare token', () => {
    expect(parseKey('abc-123', 'lenient')).toEqual({ ok: true, key: 'abc-123' });
    expect(parseKey('  abc  ', 'lenient')).toEqual({ ok: true, key: 'abc' });
  });

  test('REQ-CORE-3: lenient strips quotes and unescapes an sf-string', () => {
    expect(parseKey('"abc"', 'lenient')).toEqual({ ok: true, key: 'abc' });
    expect(parseKey('"a\\"b"', 'lenient')).toEqual({ ok: true, key: 'a"b' });
    expect(parseKey('"with space"', 'lenient')).toEqual({ ok: true, key: 'with space' });
  });

  test('REQ-CORE-3: strict requires an sf-string', () => {
    expect(parseKey('"abc"', 'strict')).toEqual({ ok: true, key: 'abc' });
    const bare = parseKey('abc', 'strict');
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.code).toBe('invalid-key');
  });

  test('REQ-CORE-3: an unterminated quote is invalid in both modes', () => {
    expect(parseKey('"abc', 'strict').ok).toBe(false);
    expect(parseKey('"abc', 'lenient').ok).toBe(false);
  });

  test('REQ-CORE-2: an empty sf-string is invalid-key', () => {
    const result = parseKey('""', 'lenient');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch('empty');
  });

  test('REQ-CORE-2: a 256 byte bare key is invalid-key', () => {
    const result = parseKey('a'.repeat(256), 'lenient');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-key');
  });

  test('REQ-CORE-2: a quoted key over 255 bytes is invalid-key', () => {
    expect(parseKey(`"${'a'.repeat(256)}"`, 'strict').ok).toBe(false);
  });

  test('REQ-CORE-2: surrounding spaces and tabs are optional whitespace and are discarded', () => {
    expect(parseKey('\t abc \t', 'lenient')).toEqual({ ok: true, key: 'abc' });
  });

  test('REQ-CORE-2: other whitespace around the value is not optional whitespace and is rejected', () => {
    expect(parseKey('\x0babc', 'lenient').ok).toBe(false);
    expect(parseKey('\xa0"abc"', 'strict').ok).toBe(false);
  });
});
