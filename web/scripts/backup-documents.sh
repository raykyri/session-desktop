#!/bin/sh
# Document archive (`docs/13-deployment-fly.md` §6).
#
# Litestream replicates session.db continuously; `/data/documents` (image
# attachments, `<owner_id>/<sha256>` and their thumbnails) is files on a
# volume and nothing replicates it, so it is tarred and shipped to the same
# bucket. Content-addressed files are immutable; filtering by modification time
# relative to the stamp file captures newly added files.
#
# The server runs this script itself (`packages/server/src/backups.ts`): at
# boot and every hour it checks the stamp file's age and runs the script when
# the stamp is missing or a day old. The stamp is touched only after a
# successful run, so its age is the time since the last good archive
# (`session_documents_backup_age_seconds`). To force one from inside the
# machine:
#
#   fly ssh console -a session-dev -C "/app/scripts/backup-documents.sh"

set -eu

SESSION_DATA_DIR="${SESSION_DATA_DIR:-/data}"
DOCUMENTS_DIR="$SESSION_DATA_DIR/documents"
MARKER="$SESSION_DATA_DIR/tmp/documents-backup.stamp"
WORK_DIR="${TMPDIR:-$SESSION_DATA_DIR/tmp}"

# The same bucket as the database replica unless one is named explicitly.
TARGET="${SESSION_DOCUMENTS_REPLICA_URL:-}"
if [ -z "$TARGET" ]; then
  if [ -z "${LITESTREAM_REPLICA_URL:-}" ]; then
    echo "backup-documents: set SESSION_DOCUMENTS_REPLICA_URL or LITESTREAM_REPLICA_URL" >&2
    exit 2
  fi
  TARGET="${LITESTREAM_REPLICA_URL%/}/documents"
fi

if [ ! -d "$DOCUMENTS_DIR" ]; then
  echo "backup-documents: $DOCUMENTS_DIR does not exist; nothing to archive" >&2
  exit 0
fi

started_at="$(date -u +%Y%m%dT%H%M%SZ)"
# The marker is stamped with the moment the file list was taken, not with the
# moment the upload finished: a document written while the archive was building
# remains newer than the marker and is included in the next run.
started_epoch="$(date -u +%s)"
archive="$WORK_DIR/documents-$started_at.tar.gz"
list="$WORK_DIR/documents-$started_at.list"
trap 'rm -f "$archive" "$list" "$list.rel"' EXIT

if [ -f "$MARKER" ]; then
  kind="incremental"
  find "$DOCUMENTS_DIR" -type f -newer "$MARKER" -print > "$list"
else
  kind="full"
  find "$DOCUMENTS_DIR" -type f -print > "$list"
fi

count="$(wc -l < "$list" | tr -d ' ')"
if [ "$count" = "0" ]; then
  echo "backup-documents: no new documents since $(date -u -r "$MARKER" 2>/dev/null || echo 'the last run')"
  # Advance the timestamp marker even when no new documents were found.
  touch -d "@$started_epoch" "$MARKER"
  exit 0
fi

# Paths go into the archive relative to the data directory, so restoring is
# `tar -xzf` at $SESSION_DATA_DIR with nothing to strip.
sed "s#^$DOCUMENTS_DIR/#documents/#" "$list" > "$list.rel"
tar -czf "$archive" -C "$SESSION_DATA_DIR" -T "$list.rel"

key="documents-$started_at-$kind.tar.gz"
node "$(dirname "$0")/s3-put.mjs" "$archive" "${TARGET%/}/$key"

touch -d "@$started_epoch" "$MARKER"
echo "backup-documents: uploaded $count file(s) as $key ($(wc -c < "$archive" | tr -d ' ') bytes)"
