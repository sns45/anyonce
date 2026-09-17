
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
