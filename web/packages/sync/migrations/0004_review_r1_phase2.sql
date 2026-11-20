-- Review round 1 of phase 2. Two new indexes: a thread's author
-- (`thread.u`), for the account read that counts the spaces a person wrote
-- in (`SyncServer.authorSpaces`), and a run's status (`run.status`), so the
-- queued and running runs are a scan (`queuedRunsPerUser`). The stored
-- records get their index rows here; later writes keep them.

INSERT INTO sync_index (kind, field, value, key)
SELECT 'thread', 'u', json_extract(body, '$.u'), key
FROM sync_records
WHERE kind = 'thread' AND json_type(body, '$.u') = 'text';

INSERT INTO sync_index (kind, field, value, key)
SELECT 'run', 'status', json_extract(body, '$.status'), key
FROM sync_records
WHERE kind = 'run' AND json_type(body, '$.status') = 'text';
