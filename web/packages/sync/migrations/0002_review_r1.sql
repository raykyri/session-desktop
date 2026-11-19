-- Review round 1 of phase 1. A device run's lease keeps its last heartbeat
-- and the number of its attempt's last in-flight event: the run record holds
-- neither (a heartbeat changes no log). The hourly limit of device runs
-- counts starts here, not run records. The database's instance id (cursor
-- tokens carry it) is `sync_meta` key 'instance'.

ALTER TABLE sync_leases ADD COLUMN beat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_leases ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sync_device_runs (
  u TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX sync_device_runs_u ON sync_device_runs (u, at);
CREATE INDEX sync_device_runs_at ON sync_device_runs (at);
