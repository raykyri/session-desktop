-- Review round 2 of phase 2: the queued runs limit (`queuedRunsPerUser`)
-- reads the person's runs over `run.u` and filters them by status, so the
-- run status index of 0004 has no reader. Its rows are dropped; writes no
-- longer add them.

DELETE FROM sync_index WHERE kind = 'run' AND field = 'status';
