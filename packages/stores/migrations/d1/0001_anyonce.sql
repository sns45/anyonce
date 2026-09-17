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
