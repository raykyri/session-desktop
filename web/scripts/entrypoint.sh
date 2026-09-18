#!/bin/sh
# Container entrypoint (`docs/13-deployment-fly.md` §3, §5).
#
# Initializes volume permissions and credentials as root, then runs the server
# as the unprivileged `session` user (uid 1000). With LITESTREAM_REPLICA_URL set,
# the server runs as Litestream's child so replication covers all writes.

set -eu

SESSION_DATA_DIR="${SESSION_DATA_DIR:-/data}"
SERVER_ENTRY="${SERVER_ENTRY:-/app/packages/server/dist/server.mjs}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"

mkdir -p "$SESSION_DATA_DIR" "$SESSION_DATA_DIR/documents" "$SESSION_DATA_DIR/tmp"

if [ "$(id -u)" = "0" ]; then
  # A Fly volume arrives owned by root. Only the directories and the database
  # files are touched: a recursive chown over `documents/` would grow with the
  # corpus and run on every boot.
  chown session:session "$SESSION_DATA_DIR" "$SESSION_DATA_DIR/documents" "$SESSION_DATA_DIR/tmp"
  for file in "$SESSION_DATA_DIR"/session.db "$SESSION_DATA_DIR"/session.db-wal "$SESSION_DATA_DIR"/session.db-shm; do
    if [ -e "$file" ]; then
      chown session:session "$file"
    fi
  done
fi

# The server writes this file itself at boot (`main.ts:writeVertexCredentials`);
# it is written here as well so Litestream, which starts first and can use the
# same credential for a GCS replica, sees it too. Same path, same contents.
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS_JSON:-}" ]; then
  credentials="$SESSION_DATA_DIR/tmp/vertex-credentials.json"
  (
    umask 077
    printf '%s' "$GOOGLE_APPLICATION_CREDENTIALS_JSON" > "$credentials"
  )
  chmod 600 "$credentials"
  if [ "$(id -u)" = "0" ]; then
    chown session:session "$credentials"
  fi
  GOOGLE_APPLICATION_CREDENTIALS="$credentials"
  export GOOGLE_APPLICATION_CREDENTIALS
fi

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  # Use `-restore-if-db-not-exists` to automatically restore existing database replicas to new volumes, or initialize a fresh database if none exists.
  set -- litestream replicate \
    -config "$LITESTREAM_CONFIG" \
    -restore-if-db-not-exists \
    -exec "node $SERVER_ENTRY"
else
  echo "litestream: LITESTREAM_REPLICA_URL is unset; running without replication" >&2
  set -- node "$SERVER_ENTRY"
fi

if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=1000 --regid=1000 --clear-groups "$@"
fi
exec "$@"
