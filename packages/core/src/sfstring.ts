export type SfStringResult = { ok: true; value: string } | { ok: false; reason: string };

function fail(reason: string): SfStringResult {
  return { ok: false, reason };
}

function trimSpaces(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && input.charCodeAt(start) === 0x20) start++;
  while (end > start && input.charCodeAt(end - 1) === 0x20) end--;
  return input.slice(start, end);
}

/**
 * Parses one RFC 9651 sf-string (section 4.2.5): a DQUOTE, then printable ASCII with backslash escapes for
 * DQUOTE and backslash only, then a closing DQUOTE. Surrounding spaces are discarded. Anything after the
 * closing quote (including parameters) is rejected because the key is the whole field value.
 */
export function parseSfString(input: string): SfStringResult {
  const s = trimSpaces(input);
  if (s.length === 0 || s.charCodeAt(0) !== 0x22)
    return fail('not an sf-string: missing opening quote');
  let out = '';
  let i = 1;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 0x5c) {
      i++;
      if (i >= s.length) return fail('unterminated escape');
      const next = s.charCodeAt(i);
      if (next !== 0x22 && next !== 0x5c) return fail(`invalid escape \\${s[i]}`);
      out += s[i];
      i++;
      continue;
    }
    if (code === 0x22) {
      if (i + 1 < s.length) return fail('trailing characters after the closing quote');
      return { ok: true, value: out };
    }
    if (code < 0x20 || code > 0x7e)
      return fail('non-printable or non-ASCII character in sf-string');
    out += s[i];
    i++;
  }
  return fail('unterminated quote');
}
