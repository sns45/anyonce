/** REQ-CORE-5: a fresh UUID version 4 from Web Crypto. */
export function newKey(): string {
  return crypto.randomUUID();
}

/** NFR-2: the only form of a key that may ever reach a log line. */
export function redactKey(key: string): string {
  return `${key.slice(0, 8)}…`;
}
