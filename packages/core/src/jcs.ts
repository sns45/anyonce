export class JcsError extends Error {
  override readonly name = 'JcsError';
}

function serializeObject(value: object): string {
  const maybe = value as { toJSON?: unknown };
  if (typeof maybe.toJSON === 'function')
    return serialize((maybe.toJSON as () => unknown).call(value));
  if (Array.isArray(value)) {
    // A hole is not a member, so map would skip it and leave an empty slot in the output. JSON.stringify writes
    // null for a hole and the canonical form must stay valid JSON, so write null here too.
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) items.push(i in value ? serialize(value[i]) : 'null');
    return `[${items.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`;
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError('non-finite numbers cannot be canonicalized');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return serializeObject(value);
    default:
      throw new JcsError(`${typeof value} values cannot be canonicalized`);
  }
}

/**
 * RFC 8785 JSON Canonicalization Scheme. Numbers follow ECMAScript Number::toString (which JSON.stringify
 * implements), strings use the JSON.stringify escaping rules the RFC mandates, and object members are sorted by
 * UTF-16 code units (the default Array.prototype.sort order for strings).
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}
