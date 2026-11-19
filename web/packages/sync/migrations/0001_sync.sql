-- The sync core's server tables (@session/sync, phase 1b). One SQLite
-- database; every write of the server half commits in one transaction.
-- Times are milliseconds since the epoch; versions come from one sequence
-- (sync_meta.head) and never leave the server.

CREATE TABLE sync_meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
) STRICT;

-- Records as mutators write them (JSON), with the version of the commit
-- that created each.
CREATE TABLE sync_records (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  born INTEGER NOT NULL
) STRICT;

-- The scans of @session/mutators' INDEXES: one row per (kind, field,
-- value) of each record, written with it.
CREATE TABLE sync_index (
  kind TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (kind, field, value, key)
) STRICT, WITHOUT ROWID;
CREATE INDEX sync_index_key ON sync_index (key);

-- Every id and key ever written, with its last rev: never reused.
CREATE TABLE sync_registry (
  id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- The change log: one row per (log, key), key, operation and version only
-- (`ord` orders the rows of one commit as it wrote them).
CREATE TABLE sync_log (
  log TEXT NOT NULL,
  key TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('put', 'del')),
  version INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (log, key)
) STRICT, WITHOUT ROWID;
CREATE INDEX sync_log_version ON sync_log (log, version, ord);

-- A log's history: replaced when a space opens or closes.
CREATE TABLE sync_epochs (
  log TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  start INTEGER NOT NULL
) STRICT;

-- Deleted records for 30 days: key, kind and audience fields, no text.
CREATE TABLE sync_tombstones (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sp TEXT,
  person TEXT,
  who TEXT,
  type TEXT,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_tombstones_at ON sync_tombstones (at);

-- Recorded answers, 7 days: by (user, mutation id), and by (client, seq)
-- for a malformed or reused mutation id. No record text: a STALE answer
-- keeps the keys it is about.
CREATE TABLE sync_answers (
  u TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  answer TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (u, mutation_id)
) STRICT;
CREATE INDEX sync_answers_at ON sync_answers (at);

CREATE TABLE sync_seq_answers (
  client_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  digest TEXT NOT NULL,
  answer TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (client_id, seq)
) STRICT;
CREATE INDEX sync_seq_answers_at ON sync_seq_answers (at);

-- Registered clients: user, device, last processed seq, last use (90 days).
CREATE TABLE sync_clients (
  id TEXT PRIMARY KEY,
  u TEXT NOT NULL,
  device TEXT,
  last INTEGER NOT NULL,
  seen INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_clients_seen ON sync_clients (seen);
CREATE INDEX sync_clients_device ON sync_clients (device);

CREATE TABLE sync_registrations (
  u TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_registrations_u ON sync_registrations (u, at);
CREATE INDEX sync_registrations_at ON sync_registrations (at);

-- Post-commit effects (ids and keys, no text), and the ones that failed 10 times.
CREATE TABLE sync_effects (
  id INTEGER PRIMARY KEY,
  effect TEXT NOT NULL,
  at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  next INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_effects_next ON sync_effects (next);

CREATE TABLE sync_dead_letters (
  id INTEGER PRIMARY KEY,
  effect TEXT NOT NULL,
  at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  failed_at INTEGER NOT NULL
) STRICT;

-- Device tokens (their SHA-256 only), device sign-ins, and device run leases.
CREATE TABLE sync_device_tokens (
  device TEXT PRIMARY KEY,
  u TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  revoked_at INTEGER
) STRICT;

CREATE TABLE sync_signins (
  request TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_signins_at ON sync_signins (at);

CREATE TABLE sync_leases (
  run TEXT PRIMARY KEY,
  until INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_leases_until ON sync_leases (until);
