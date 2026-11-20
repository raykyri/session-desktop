-- Phase 2b. A space's visibility is indexed (`space.vis`), so the directory
-- (`SyncServer.directory`: the open and listed spaces anyone may find) is a
-- scan. The stored spaces get their index rows here; later writes keep them.

INSERT INTO sync_index (kind, field, value, key)
SELECT 'space', 'vis', json_extract(body, '$.vis'), key
FROM sync_records
WHERE kind = 'space' AND json_type(body, '$.vis') = 'text';
