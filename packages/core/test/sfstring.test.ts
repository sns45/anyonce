import { describe, expect, test } from 'bun:test';
import { parseSfString } from '../src/sfstring';

describe('parseSfString', () => {
  const ok: Array<[string, string]> = [
    ['"abc"', 'abc'],
    ['"hello world"', 'hello world'],
    ['"foo \\"bar\\" \\\\ baz"', 'foo "bar" \\ baz'],
    ['"a\\"b"', 'a"b'],
    ['""', ''],
    ['  "padded"  ', 'padded'],
    ['"8e03978e-40d5-43e8-bc93-6894a57f9324"', '8e03978e-40d5-43e8-bc93-6894a57f9324'],
  ];
  for (const [input, value] of ok) {
    test(`REQ-CORE-3: accepts ${JSON.stringify(input)}`, () => {
      expect(parseSfString(input)).toEqual({ ok: true, value });
    });
  }

  const bad: Array<[string, string]> = [
    ['abc', 'missing opening quote'],
    ['', 'missing opening quote'],
    ['"abc', 'unterminated'],
    ['"abc"x', 'trailing'],
    ['"abc";a=1', 'trailing'],
    ['"a\\nb"', 'invalid escape'],
    ['"a\\', 'unterminated escape'],
    ['"café"', 'non-printable or non-ASCII'],
    ['"tab\there"', 'non-printable or non-ASCII'],
    ['"del\x7f"', 'non-printable or non-ASCII'],
  ];
  for (const [input, reason] of bad) {
    test(`REQ-CORE-3: rejects ${JSON.stringify(input)}`, () => {
      const result = parseSfString(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    });
  }
});
