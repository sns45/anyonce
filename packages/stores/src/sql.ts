/**
 * Statements shared by the SQLite dialect stores (D1, Durable Objects) and, through pgSql, Postgres.
 * Parameters: begin ?1 scope, ?2 key, ?3 fingerprint, ?4 now, ?5 lease_until (precomputed now + leaseMs),
 * ?6 expires_at (precomputed now + ttlMs). The caller precomputes ?5 and ?6 because after pgSql rewrites
 * ?N to $N, an expression such as $4 + $5 is an ambiguous operator to Postgres; binding the final values
 * keeps one statement working for both dialects.
 */
export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS anyonce_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  result_meta TEXT,
  result_body BLOB,
  result_omitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS anyonce_records_expires_at ON anyonce_records (expires_at);
`;

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS anyonce_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  fence BIGINT NOT NULL,
  lease_until BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  result_meta TEXT,
  result_body BYTEA,
  result_omitted SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS anyonce_records_expires_at ON anyonce_records (expires_at);
`;

/** D4: the claim is this one statement. A refused write returns no row; SELECT_SQL then classifies it. */
export const BEGIN_SQL = `
INSERT INTO anyonce_records (scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted)
VALUES (?1, ?2, ?3, 'in_flight', 1, ?5, ?4, ?6, NULL, NULL, 0)
ON CONFLICT(scope, key) DO UPDATE SET
  fingerprint = excluded.fingerprint,
  state = 'in_flight',
  fence = anyonce_records.fence + 1,
  lease_until = excluded.lease_until,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  result_meta = NULL,
  result_body = NULL,
  result_omitted = 0
WHERE anyonce_records.expires_at <= ?4
   OR (anyonce_records.fingerprint = excluded.fingerprint AND anyonce_records.state = 'in_flight' AND anyonce_records.lease_until <= ?4)
RETURNING fence`;

/** ?1 scope, ?2 key, ?3 fence, ?4 now, ?5 result_meta, ?6 result_body, ?7 result_omitted. */
export const COMPLETE_SQL = `
UPDATE anyonce_records SET state = 'completed', result_meta = ?5, result_body = ?6, result_omitted = ?7
WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND expires_at > ?4 AND state = 'in_flight'
RETURNING fence`;

/** ?1 scope, ?2 key, ?3 fence. */
export const ABANDON_SQL = `
DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND state = 'in_flight'
RETURNING fence`;

/** ?1 scope, ?2 key, ?3 now. */
export const GET_SQL = `
SELECT scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted
FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND expires_at > ?3`;

/** ?1 scope, ?2 key: the raw row, expired or not, used to classify a refused write. */
export const SELECT_SQL = `
SELECT scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted
FROM anyonce_records WHERE scope = ?1 AND key = ?2`;

/**
 * ?1 now. No RETURNING: every driver already reports how many rows a DELETE affected (pg rowCount, postgres.js
 * count, D1 meta.changes, Durable Object SqlStorageCursor.rowsWritten, Go RowsAffected), and materializing one
 * row per expired record only to count them costs memory on exactly the sweep that has the most to remove.
 * This makes the statement byte identical to the Go one.
 */
export const PURGE_SQL = `DELETE FROM anyonce_records WHERE expires_at <= ?1`;

/** ?1 scope, ?2 key: test-only physical removal. */
export const REMOVE_SQL = `DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2`;

/** Rewrites ?N placeholders to $N for Postgres, leaving single-quoted text alone. */
export function pgSql(text: string): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote && ch === '?' && /[0-9]/.test(text[i + 1] ?? '')) {
      out += '$';
      continue;
    }
    out += ch;
  }
  return out;
}
