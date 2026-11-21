// The boot steps after the database is open and migrated (`01` S5, D6;
// `03` K1, E2), in order:
//
// 1. the restore check: a database file of another generation than the one
//    recorded bumps every log's epoch, so every cursor from before resyncs;
// 2. the ledger rows a crash left `open` are closed with their last
//    checkpoint;
// 3. runs still `running` become `interrupted`;
// 4. the run dispatcher starts (`runs/runtime.ts`), when there is one, and
//    the scheduled maintenance (the sync retention of Y8).
//
// `main.ts` calls it before it listens, so the health check stays `starting`
// until every step is done.

import { checkRestore, databaseGeneration, type RestoreCheck } from "@session/db";

import type { Logger } from "./logger.js";
import type { Dispatcher } from "./runs/dispatcher.js";
import type { Ledger } from "./runs/ledger.js";
import type { SyncService } from "./sync/service.js";

export interface BootDeps {
  databasePath: string;
  sync: SyncService;
  ledger: Ledger;
  logger: Logger;
  /** Started last; absent in the tests that boot without runs. */
  dispatcher?: Dispatcher;
  now?: () => number;
}

export interface BootReport {
  restore: RestoreCheck;
  closedRows: number;
  interrupted: number;
  /** The steps in the order they ran. */
  steps: string[];
}

export function bootServer(deps: BootDeps): BootReport {
  const now = deps.now ?? Date.now;
  const steps: string[] = [];
  const restore = checkRestore(deps.sync.store, databaseGeneration(deps.databasePath), now());
  steps.push("restore check");
  if (restore.bumped > 0)
    deps.logger.warn(
      { previous: restore.previous, current: restore.current, logs: restore.bumped },
      "database generation changed: every log's epoch was bumped",
    );
  const closedRows = deps.ledger.closeOpen(now());
  steps.push("close open usage rows");
  const interrupted = deps.sync.interruptRunning();
  steps.push("interrupt running runs");
  if (deps.dispatcher) {
    // its own boot repeats steps 2 and 3 over the run store, finding nothing,
    // and queues the interrupted runs it may resume (`03` E2)
    deps.dispatcher.boot();
    deps.dispatcher.start();
    steps.push("start the dispatcher");
  }
  deps.sync.startMaintenance();
  steps.push("start maintenance");
  deps.logger.info({ closedRows, interrupted, restore }, "booted");
  return { restore, closedRows, interrupted, steps };
}
